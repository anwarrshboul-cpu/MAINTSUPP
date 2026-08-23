"use client";

/**
 * The board header's state and the surfaces its buttons open.
 *
 * `board-chrome.tsx` is a thin composer held to 500 lines, so everything the
 * header row needs that is not drawing lives here: the two counts (fetched,
 * never hardcoded), the board's settings record, which dialog is open, the
 * clipboard, and the ⋯ menu. The header itself stays a pure row.
 *
 * COUNTS ARE THE API'S. `Automations / 3` is `counts.enabled` from
 * `/api/automations` — enabled rules are the ones doing anything — and the
 * Invite badge is the member list's length from `/api/board/members`. Until
 * each has answered the badge is simply absent; a placeholder number would be
 * a claim about the board nobody has checked. The automations modal fires
 * `maintsupp:automations-changed` on every write and the count re-fetches.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import BoardHeader from "../board-header";
import { copyBoardText } from "../board-export";
import { AutomationsModal } from "./automations-modal";
import { BoardDiscussion } from "./board-discussion";
import { BoardOptionsMenu } from "./board-options-menu";
import { RenameBoardDialog, TerminologyDialog } from "./board-settings-dialogs";
import { InviteModal } from "./invite-modal";
import { boardLink } from "./board-link";
import "./board-actions.css";

export type BoardSettings = {
  board: { id: string; key: string; name: string; itemNoun: string };
  canEdit: boolean;
};

export function BoardActionsHost({
  boardId,
  boardName,
  activeKey,
}: {
  boardId: string;
  /** The name the chrome already knows; the settings record refines it. */
  boardName: string;
  /** The open view tab, so "Copy link" names it. */
  activeKey: string;
}) {
  const [automationCount, setAutomationCount] = useState<number | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [settings, setSettings] = useState<BoardSettings | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [open, setOpen] = useState<
    null | "automations" | "invite" | "discussion" | "options" | "rename" | "terminology"
  >(null);
  const optionsRef = useRef<HTMLButtonElement | null>(null);

  const loadAutomationCount = useCallback(async () => {
    try {
      const response = await fetch(`/api/automations?boardId=${encodeURIComponent(boardId)}`);
      if (!response.ok) return;
      const payload = (await response.json()) as { counts?: { total: number; enabled: number } };
      if (payload.counts) setAutomationCount(payload.counts.enabled);
    } catch {
      // Left blank. The badge says nothing rather than something untrue.
    }
  }, [boardId]);

  const loadMemberCount = useCallback(async () => {
    try {
      const response = await fetch("/api/board/members");
      if (!response.ok) return;
      const payload = (await response.json()) as { members?: unknown[] };
      if (Array.isArray(payload.members)) setMemberCount(payload.members.length);
    } catch {
      // As above.
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const response = await fetch(`/api/board/settings?board=${encodeURIComponent(boardId)}`);
      if (!response.ok) return;
      setSettings((await response.json()) as BoardSettings);
    } catch {
      // The chrome's own name stands.
    }
  }, [boardId]);

  // Deferred through a timer, as every load in portal-app.tsx is, so the
  // three reads start on a later tick rather than cascading a render.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAutomationCount();
      void loadMemberCount();
      void loadSettings();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAutomationCount, loadMemberCount, loadSettings]);

  useEffect(() => {
    const onChanged = () => void loadAutomationCount();
    window.addEventListener("maintsupp:automations-changed", onChanged);
    return () => window.removeEventListener("maintsupp:automations-changed", onChanged);
  }, [loadAutomationCount]);

  // "Copied" stands for two seconds, then the button reads "Copy link" again.
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyLink = useCallback(async () => {
    const link = boardLink(window.location.origin, window.location.pathname, activeKey || null);
    try {
      await copyBoardText(link);
      setCopied(true);
      setCopyError(null);
    } catch {
      setCopyError(link);
    }
  }, [activeKey]);

  /*
   * The name on the row. A rename made in this session shows at once; until
   * then the chrome's own heading wins, because a workspace section may title
   * the board differently from the board record and that title is the one
   * the person clicked in the sidebar.
   */
  const [renamedTo, setRenamedTo] = useState<string | null>(null);
  const displayName = renamedTo ?? boardName ?? settings?.board.name ?? "Board";
  const itemNoun = settings?.board.itemNoun ?? "item";

  const close = useCallback(() => setOpen(null), []);

  return (
    <>
      <BoardHeader
        boardName={displayName}
        automationCount={automationCount}
        memberCount={memberCount}
        copied={copied}
        optionsOpen={open === "options"}
        optionsRef={optionsRef}
        onAutomations={() => setOpen("automations")}
        onDiscussion={() => setOpen("discussion")}
        onInvite={() => setOpen("invite")}
        onCopyLink={() => void copyLink()}
        onOptions={() => setOpen((current) => (current === "options" ? null : "options"))}
      />

      {copyError && (
        <p className="ba-copy-fallback" role="status">
          The clipboard is unavailable here. Copy this address:{" "}
          <code>{copyError}</code>
          <button type="button" className="ba-btn ba-btn--quiet ba-btn--small" onClick={() => setCopyError(null)}>
            Dismiss
          </button>
        </p>
      )}

      <AutomationsModal
        open={open === "automations"}
        onClose={close}
        boardId={boardId}
        boardName={displayName}
      />

      <InviteModal open={open === "invite"} onClose={close} onMembersChanged={loadMemberCount} />

      <BoardDiscussion
        open={open === "discussion"}
        onClose={close}
        boardId={boardId}
        boardName={displayName}
      />

      <BoardOptionsMenu
        open={open === "options"}
        anchorRef={optionsRef}
        onClose={close}
        boardId={boardId}
        boardName={displayName}
        canEditSettings={settings?.canEdit ?? null}
        onDiscussion={() => setOpen("discussion")}
        onRename={() => setOpen("rename")}
        onTerminology={() => setOpen("terminology")}
      />

      <RenameBoardDialog
        open={open === "rename"}
        onClose={close}
        boardId={boardId}
        currentName={displayName}
        canEdit={settings?.canEdit ?? null}
        onRenamed={(name) => {
          setRenamedTo(name);
          void loadSettings();
          window.dispatchEvent(new Event("maintsupp:refresh-board"));
        }}
      />

      <TerminologyDialog
        open={open === "terminology"}
        onClose={close}
        boardId={boardId}
        currentNoun={itemNoun}
        canEdit={settings?.canEdit ?? null}
        onChanged={() => {
          void loadSettings();
          window.dispatchEvent(new Event("maintsupp:refresh-board"));
        }}
      />
    </>
  );
}
