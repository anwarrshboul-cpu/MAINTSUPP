"use client";

/**
 * The workspace roster the "Assigned To" picker chooses from.
 *
 * WHAT THIS CLOSES. `maintenance_requests.assignee` is a plain TEXT column, and
 * the board derived the Assigned To options from the values already sitting on
 * its own rows (`assigneeFilterOptions` in board-model.ts). That is right for a
 * FILTER — you can only filter by a name somebody is filed under — and it is
 * exactly wrong for an EDITOR: on an estate where nobody has been assigned yet
 * the only entry in the dropdown is "Unassigned", so the board could not be
 * used to assign a job to anybody, ever. The owner's words: "We must be able to
 * assign a job to a person in the workspace."
 *
 * WHERE THE PEOPLE COME FROM. `GET /api/board/members` — the roster the Invite
 * dialog already draws, resolved through `scopedDb()` so it is this
 * organisation's active memberships and nobody else's. It is deliberately NOT a
 * second endpoint: a picker with its own roster query would be a second place
 * for the org filter to be got wrong, and the two lists would drift the first
 * time one of them learned about deactivated users. One route, one filter.
 *
 * WHY A MODULE-LEVEL CACHE. Every visible row renders an Assigned To cell, so a
 * per-cell fetch would be one request per row. The roster is fetched at most
 * once per page and shared: the first cell to be OPENED starts the load, every
 * mounted cell is told when it lands, and cells that are never opened cost
 * nothing. `invalidateAssigneeDirectory()` drops it so a workspace that has just
 * invited somebody can pick them up without a reload.
 */

import { useEffect, useState } from "react";

export type WorkspaceMember = {
  id: string;
  name: string;
  email: string;
  role: string;
  title: string | null;
  avatarColour: string | null;
  /** True for the signed-in user, so the picker can offer "Assign to me". */
  isMe: boolean;
};

export type AssigneeDirectory = {
  members: WorkspaceMember[];
  loading: boolean;
  /** A reason to show in the picker, never a silent empty list. */
  error: string | null;
};

const EMPTY: AssigneeDirectory = { members: [], loading: false, error: null };

let cached: AssigneeDirectory = EMPTY;
let inflight: Promise<void> | null = null;
const listeners = new Set<(value: AssigneeDirectory) => void>();

function publish(next: AssigneeDirectory) {
  cached = next;
  for (const listener of listeners) listener(next);
}

/**
 * The roster rows, defensively.
 *
 * This is a network payload, so every field is checked rather than asserted: a
 * roster row missing a name must render as its email rather than as `undefined`
 * in the middle of a person picker.
 */
function readMembers(payload: unknown): WorkspaceMember[] {
  const rows = (payload as { members?: unknown } | null)?.members;
  if (!Array.isArray(rows)) return [];
  const people: WorkspaceMember[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : "";
    const email = typeof entry.email === "string" ? entry.email : "";
    if (!id) continue;
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : email;
    if (!name) continue;
    people.push({
      id,
      name,
      email,
      role: typeof entry.role === "string" ? entry.role : "",
      title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : null,
      avatarColour:
        typeof entry.avatarColour === "string" && entry.avatarColour.trim()
          ? entry.avatarColour.trim()
          : null,
      isMe: entry.isMe === true,
    });
  }
  return people;
}

/** Starts the one load, or joins the one already running. */
export function loadAssigneeDirectory(): Promise<void> {
  if (cached.members.length && !cached.error) return Promise.resolve();
  if (inflight) return inflight;
  publish({ members: cached.members, loading: true, error: null });
  inflight = (async () => {
    try {
      const response = await fetch("/api/board/members", {
        headers: { Accept: "application/json" },
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error || "The workspace roster is unavailable.");
      }
      publish({ members: readMembers(payload), loading: false, error: null });
    } catch (caught) {
      publish({
        members: [],
        loading: false,
        error:
          caught instanceof Error
            ? caught.message
            : "The workspace roster is unavailable.",
      });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Drops the cache so the next open re-reads the roster. */
export function invalidateAssigneeDirectory() {
  inflight = null;
  publish(EMPTY);
}

/**
 * The roster, loaded lazily.
 *
 * `enabled` is the picker's own open state: nothing is fetched until somebody
 * actually opens one, and the second picker opened on the same page reads the
 * cache rather than the network.
 */
export function useAssigneeDirectory(enabled: boolean): AssigneeDirectory {
  const [state, setState] = useState<AssigneeDirectory>(cached);

  useEffect(() => {
    listeners.add(setState);
    setState(cached);
    return () => {
      listeners.delete(setState);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void loadAssigneeDirectory();
  }, [enabled]);

  return state;
}

/**
 * The people a search box has narrowed to.
 *
 * Name, email and job title are all searched, because "who is Priya" and "who
 * is the facilities manager" are the same question asked two ways, and a
 * picker that only matched the display name made the title it renders
 * un-searchable.
 *
 * Pure and exported so it can be tested without a browser.
 */
export function filterMembers(members: WorkspaceMember[], search: string): WorkspaceMember[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return members;
  return members.filter((member) =>
    [member.name, member.email, member.title ?? ""].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

/**
 * A person's initials, for the avatar disc.
 *
 * At most two letters, taken from the display name, falling back to the email's
 * local part — an account that has never been given a name still gets a disc
 * with something in it rather than an empty circle.
 *
 * PUNCTUATION IS NOT AN INITIAL. Splitting on whitespace alone turned "Admin
 * (testing)" into the disc "A(" on the real board — measured, not imagined —
 * because the second word begins with a bracket. Only word CHARACTERS are
 * considered, so a parenthesised qualifier, a hyphenated surname and an
 * apostrophe all give a letter or are skipped.
 */
export function memberInitials(member: { name: string; email: string }): string {
  const source = member.name.trim() || member.email.split("@")[0] || "";
  const words = source.match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu) ?? [];
  // One word gets two of its own letters — a disc reading "C" for "Cher" looks
  // like a rendering fault rather than a person. Apostrophes are dropped from
  // that pair, so "O'Brien" is OB and not "O'".
  const letters =
    words.length === 1
      ? words[0].replace(/['’]/g, "").slice(0, 2)
      : words.slice(0, 2).map((word) => word[0]).join("");
  return (letters || source.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2)).toUpperCase();
}

/**
 * The colour of a person's disc.
 *
 * A stored `avatar_colour` wins. Otherwise it is derived from the user id, so
 * the same person keeps the same colour on every board, in every session and on
 * every device — a colour picked from an array index would change the moment
 * somebody else was invited.
 */
const AVATAR_PALETTE = [
  "#0073ea",
  "#00854d",
  "#7e3b8a",
  "#a25ddc",
  "#bb3354",
  "#c2820b",
  "#175a63",
  "#944f00",
];

export function memberColour(member: { id: string; avatarColour: string | null }): string {
  if (member.avatarColour) return member.avatarColour;
  let hash = 0;
  for (let index = 0; index < member.id.length; index += 1) {
    hash = (hash * 31 + member.id.charCodeAt(index)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}
