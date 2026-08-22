"use client";

/**
 * Row 1 of the board chrome — the board's name and the actions beside it.
 *
 * Extracted from `board-chrome.tsx`, which had grown to 539 lines against the
 * 500-line ceiling `stage-eight-board-split` holds every board file to. This
 * row was the clean seam: it is the only one of the three that reads no state,
 * runs no effect and owns no handler, so moving it is a move rather than a
 * rewrite. Rows 2 and 3 both depend on the view list, the active key and the
 * loader that fills them, and splitting either would mean threading that
 * machinery through props for no gain.
 */
import { Icon } from "../../components";

export default function BoardHeader({
  boardName,
  automationCount,
}: {
  boardName: string;
  automationCount: number;
}) {
  return (
    <header className="board-header">
      <div className="board-header__title">
        <h2>{boardName}</h2>
        <button type="button" className="board-header__caret" aria-label="Board menu">
          <Icon name="chevron" size={16} />
        </button>
      </div>

      <div className="board-header__actions">
        {/*
          Both carry an `aria-label` even though both show their name, because
          below 768px `.board-header__actions … span` is display:none. That left
          Integrate an icon with no accessible name at all — axe rates an unnamed
          button critical — and left Automate announcing its badge number and
          nothing else, so a screen reader said "three, button".
        */}
        <button type="button" className="board-header__action" aria-label="Integrate">
          <Icon name="spark" size={16} />
          <span>Integrate</span>
        </button>
        <button
          type="button"
          className="board-header__action"
          aria-label={`Automate (${automationCount})`}
        >
          <Icon name="activity" size={16} />
          <span>Automate</span>
          <em className="board-header__count">{automationCount}</em>
        </button>
        {/*
          Named by `aria-label`, like the two icon-only buttons below it, and
          NOT by a visually-hidden span.

          Every off-screen-text recipe — this codebase already ships two, the
          Tailwind `.sr-only` this used and the `.visually-hidden` used
          twenty-odd times elsewhere — works by putting a real string in a
          1x1 box with `overflow: hidden`. That is 93px of clipped text at
          390px as far as any clipping audit is concerned, and it was the only
          such report on the board that was not a genuine truncation, so it
          cost a reader of that report a look every time.

          An `aria-label` carries the same accessible name with no text node
          to clip, which is why the siblings were already written this way.
        */}
        <button
          type="button"
          className="board-header__action"
          aria-label="Board updates"
        >
          <Icon name="updates" size={16} />
        </button>
        <button type="button" className="board-header__invite">Invite</button>
        <button type="button" className="board-header__action" aria-label="Share board">
          <Icon name="paperclip" size={16} />
        </button>
        <button type="button" className="board-header__action" aria-label="More board actions">
          <Icon name="more" size={16} />
        </button>
      </div>
    </header>
  );
}
