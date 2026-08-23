"use client";

/**
 * Row 1 of the board chrome — the board's name and the actions beside it.
 *
 * Extracted from `board-chrome.tsx`, which is held to 500 lines by
 * `stage-eight-board-split`. This row draws and nothing more: every count it
 * shows and every handler it calls arrives from `board-actions-host.tsx`,
 * which owns the fetches and the surfaces the buttons open.
 *
 * WHAT CHANGED IN THE UI BATCH. "Integrate" is gone — nothing in this product
 * integrates with anything, and a button that opened nowhere was a promise
 * the catalogue's greyed-out Slack and Gmail rows already decline to make.
 * The five that remain each open a real surface: Automations (the rules
 * modal, with the board's real rule count), Discussion (the board thread),
 * Invite (the member list and the invitation form, with the real member
 * count), Copy link (this board and this view) and Board options.
 */
import type { RefObject } from "react";
import { Icon } from "../../components";
import { ActionIcon } from "./board-actions/board-icons";

export type BoardHeaderProps = {
  boardName: string;
  /** From `/api/automations` — `null` until it has answered. Never a guess. */
  automationCount: number | null;
  /** From `/api/board/members` — `null` until it has answered. */
  memberCount: number | null;
  copied: boolean;
  optionsOpen: boolean;
  optionsRef: RefObject<HTMLButtonElement | null>;
  onAutomations: () => void;
  onDiscussion: () => void;
  onInvite: () => void;
  onCopyLink: () => void;
  onOptions: () => void;
};

export default function BoardHeader({
  boardName,
  automationCount,
  memberCount,
  copied,
  optionsOpen,
  optionsRef,
  onAutomations,
  onDiscussion,
  onInvite,
  onCopyLink,
  onOptions,
}: BoardHeaderProps) {
  const automationsLabel =
    automationCount === null ? "Automations" : `Automations (${automationCount})`;
  const inviteLabel = memberCount === null ? "Invite" : `Invite (${memberCount} members)`;
  return (
    <header className="board-header">
      <div className="board-header__title">
        <h2>{boardName}</h2>
        {/* The caret opens the same menu as the ⋯ at the far end — monday
            puts the board menu behind both, and so does this. */}
        <button
          type="button"
          className="board-header__caret"
          aria-label="Board menu"
          aria-haspopup="menu"
          aria-expanded={optionsOpen}
          onClick={onOptions}
        >
          <Icon name="chevron" size={16} />
        </button>
      </div>

      <div className="board-header__actions">
        {/*
          Every button carries an `aria-label` even when it shows its name,
          because below 768px `.board-header__actions … span` is display:none
          and an unnamed icon button is an axe critical. The label carries the
          count too, so a screen reader hears "Automations, 3" rather than
          "three, button".
        */}
        <button
          type="button"
          className="board-header__action"
          aria-label={automationsLabel}
          aria-haspopup="dialog"
          onClick={onAutomations}
        >
          <ActionIcon name="bolt" size={16} />
          <span>Automations</span>
          {automationCount !== null && (
            <em className="board-header__count" data-count="automations">
              {automationCount}
            </em>
          )}
        </button>
        <button
          type="button"
          className="board-header__action"
          aria-label="Discussion"
          aria-haspopup="dialog"
          onClick={onDiscussion}
        >
          <ActionIcon name="bubble" size={16} />
          <span>Discussion</span>
        </button>
        <button
          type="button"
          className="board-header__invite"
          aria-label={inviteLabel}
          aria-haspopup="dialog"
          onClick={onInvite}
        >
          <ActionIcon name="user-plus" size={16} />
          <span>Invite</span>
          {memberCount !== null && (
            <em className="board-header__count" data-count="members">
              {memberCount}
            </em>
          )}
        </button>
        <button
          type="button"
          className={`board-header__action${copied ? " is-copied" : ""}`}
          aria-label={copied ? "Link copied" : "Copy link"}
          aria-live="polite"
          onClick={onCopyLink}
        >
          <ActionIcon name={copied ? "check" : "link"} size={16} />
          <span>{copied ? "Copied" : "Copy link"}</span>
        </button>
        <button
          type="button"
          ref={optionsRef}
          className="board-header__action"
          aria-label="Board options"
          aria-haspopup="menu"
          aria-expanded={optionsOpen}
          onClick={onOptions}
        >
          <ActionIcon name="more" size={16} />
        </button>
      </div>
    </header>
  );
}
