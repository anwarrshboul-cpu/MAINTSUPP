"use client";

/**
 * The Board Discussion drawer — the conversation on the board itself.
 *
 * Draws the thread with the SAME `UpdateThread` an item's Updates tab uses:
 * `/api/board/discussion` is shaped exactly like `/api/updates` so the
 * component needs no adapter, and likes go through the likes route that
 * already recognises the `board:` prefix. Files are the one thing the board
 * thread declines — there is no item to file them against — and the server
 * says so if asked; the composer's attach control is left to say it too.
 */

import { useCallback, useEffect, useState } from "react";
import type { RequestUpdate } from "../../../lib/types";
import { UpdateThread } from "../update-thread";
import { ActionIcon } from "./board-icons";
import { BoardDrawer } from "./board-modal";

type DiscussionPayload = {
  boardId: string;
  requestId: string;
  updates: RequestUpdate[];
  total: number;
  canPost: boolean;
};

export function BoardDiscussion({
  open,
  onClose,
  boardId,
  boardName,
}: {
  open: boolean;
  onClose: () => void;
  boardId: string;
  boardName: string;
}) {
  const [updates, setUpdates] = useState<RequestUpdate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canPost, setCanPost] = useState<boolean | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [me, setMe] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/board/discussion?board=${encodeURIComponent(boardId)}`);
      const body = (await response.json().catch(() => ({}))) as DiscussionPayload & { error?: string };
      if (!response.ok) throw new Error(body.error || "The discussion could not be loaded.");
      setUpdates(body.updates);
      setCanPost(body.canPost);
      setError(null);
      setNow(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The discussion could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  // Deferred through a timer, as the loads in portal-app.tsx are, so the
  // thread starts loading on a later tick rather than cascading a render.
  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setTimeout(() => {
      void load();
      // Whose avatar sits on the composer. The context route knows; nothing
      // here guesses.
      void fetch("/api/context")
        .then((response) => (response.ok ? response.json() : null))
        .then((payload: { context?: { actor?: { displayName?: string | null; email?: string | null } } } | null) => {
          const actor = payload?.context?.actor;
          setMe(actor?.displayName || actor?.email || null);
        })
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, load]);

  const submit = useCallback(
    async (body: string, parentId: string | null, files: File[]) => {
      if (files.length) {
        throw new Error("Files cannot be attached to a board discussion — attach them to an item instead.");
      }
      const response = await fetch("/api/board/discussion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ board: boardId, body, parentId }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "The update could not be posted.");
      await load();
    },
    [boardId, load],
  );

  const onLikeChange = useCallback((updateId: string, liked: boolean, likeCount: number) => {
    const patch = (update: Omit<RequestUpdate, "replies">) =>
      update.id === updateId ? { ...update, likedByMe: liked, likeCount } : update;
    setUpdates((current) =>
      current.map((update) => ({ ...patch(update), replies: update.replies.map(patch) })),
    );
  }, []);

  return (
    <BoardDrawer open={open} onClose={onClose} title="Board Discussion" titleId="ba-discussion-title" subtitle={boardName}>
      <div className="ba-drawer__body ba-discussion">
        {canPost === false && (
          <p className="ba-hint ba-discussion__readonly" role="note">
            <ActionIcon name="info" size={14} /> You can read this discussion. Posting needs permission to edit the board.
          </p>
        )}
        {canPost !== false && (
          <p className="ba-hint ba-discussion__files">Files cannot be attached here — attach them to an item instead.</p>
        )}
        {!loading && !error && updates.length === 0 && (
          <div className="ba-discussion__empty">
            <ActionIcon name="bubble" size={32} />
            <strong>No discussion yet</strong>
            <span>Start the conversation about this board — it stays here for everyone.</span>
          </div>
        )}
        {canPost === false ? (
          <ReadOnlyThread updates={updates} now={now} />
        ) : (
          <UpdateThread
            updates={updates}
            loading={loading}
            error={error}
            now={now}
            currentUserName={me}
            onReload={load}
            onSubmit={submit}
            onLikeChange={onLikeChange}
          />
        )}
      </div>
    </BoardDrawer>
  );
}

/** The thread for somebody who may read but not write — no composer, no reply boxes. */
function ReadOnlyThread({ updates, now }: { updates: RequestUpdate[]; now: number }) {
  const age = (iso: string) => {
    const ms = now - Date.parse(iso);
    const minutes = Math.max(1, Math.round(ms / 60000));
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  };
  return (
    <ul className="ba-discussion__readlist">
      {updates.map((update) => (
        <li key={update.id}>
          <strong>{update.authorName}</strong> <small>{age(update.createdAt)}</small>
          <p>{update.body}</p>
          {update.replies.length > 0 && (
            <ul>
              {update.replies.map((reply) => (
                <li key={reply.id}>
                  <strong>{reply.authorName}</strong> <small>{age(reply.createdAt)}</small>
                  <p>{reply.body}</p>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
