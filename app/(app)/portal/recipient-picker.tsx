"use client";

/**
 * THE RECIPIENT PICKER — §6 of the calendar/reminder brief.
 *
 * One combobox that answers "who hears about this", and it is deliberately ONE
 * control rather than three. The brief allows a reminder to go to a person in
 * the workspace, to a free-typed external address, and to a dynamic group that
 * is not resolved until the moment the reminder sends. Three separate fields
 * would make the reader decide which KIND of recipient they wanted before they
 * were allowed to type a name — and the answer to "who" is usually a name, not
 * a taxonomy.
 *
 * ── WHY A GROUP CHIP MUST NOT LOOK LIKE A PERSON CHIP ──────────────────────
 *
 * "Renewal owner" and "Priya Shah" behave differently in the one way that
 * matters: the group is resolved AT SEND TIME, so if Priya leaves in April the
 * group still reaches whoever holds the role and the named chip reaches
 * nobody. §6 chose dynamic groups precisely "so staff changes don't break old
 * records". A reader who cannot see which of the two they picked cannot make
 * that choice deliberately, so a group chip carries a dashed edge and the
 * two-person glyph — a shape difference, not a colour difference, because the
 * §8 accessibility rule ("colour must never be the only signal") is a property
 * of this product and not only of the expiry scale.
 *
 * ── DE-DUPLICATION IS THE LIBRARY'S, NOT OURS ──────────────────────────────
 *
 * `normaliseRecipientEmail` is the one comparison key: lowercased and trimmed.
 * The send path de-duplicates on exactly that value (`resolveRecipientPlan`),
 * so a picker that compared addresses any other way would accept a pair it
 * believed distinct and then send one email — or, worse, accept a pair the
 * sender believed distinct and send two. The address a MEMBER carries is
 * compared too, so typing a colleague's address after picking them from the
 * roster does not add them twice by another route.
 *
 * ── VALIDATION BLOCKS THE SAVE ─────────────────────────────────────────────
 *
 * §6: "validate format; block save on invalid entries". `recipientProblem` is
 * what the dialog asks before it writes anything, and it delegates to
 * `validateRecipientRows` so the browser and the route refuse the same set of
 * strings. `isValidRecipientEmail` is stricter than "has an @" on purpose —
 * see its own note — and that strictness is the whole reason the "Add
 * ops@maintauk.co.uk" row only appears once the typed text could actually be
 * delivered to.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "../../components";
import {
  filterMembers,
  memberColour,
  memberInitials,
  useAssigneeDirectory,
  type WorkspaceMember,
} from "./assignee-directory";
import {
  DYNAMIC_GROUPS,
  dynamicGroupLabel,
  isValidRecipientEmail,
  normaliseRecipientEmail,
  validateRecipientRows,
} from "../../lib/reminders/recipients";
import "./reminder-rows.css";

/**
 * One selected recipient, in the shape `reminder_recipients` stores and the
 * shape `/api/reminders` accepts. Exactly one of the three is set.
 */
export type RecipientDraft = {
  userId: string | null;
  email: string | null;
  groupKey: string | null;
};

/**
 * The identity two recipients are compared on.
 *
 * A user id and a group key compare literally; an address compares through the
 * library's normaliser, which is the same key the send path de-duplicates on.
 */
export function recipientKey(recipient: RecipientDraft): string {
  if (recipient.groupKey) return `group:${recipient.groupKey}`;
  if (recipient.userId) return `user:${recipient.userId}`;
  return `email:${normaliseRecipientEmail(recipient.email)}`;
}

/**
 * The list with `next` added, or the list unchanged when it is already there.
 *
 * `members` is passed so that a typed address belonging to somebody already
 * chosen from the roster is recognised as the same recipient. Without it the
 * chip list can hold "Priya Shah" and "priya@…" side by side, both of which
 * resolve to one address and one of which is therefore a lie about who is
 * being written to.
 */
export function addRecipient(
  list: readonly RecipientDraft[],
  next: RecipientDraft,
  members: readonly WorkspaceMember[] = [],
): RecipientDraft[] {
  const emailOf = (entry: RecipientDraft): string => {
    if (entry.email) return normaliseRecipientEmail(entry.email);
    const member = members.find((person) => person.id === entry.userId);
    return member ? normaliseRecipientEmail(member.email) : "";
  };
  const wantedKey = recipientKey(next);
  const wantedEmail = emailOf(next);
  for (const entry of list) {
    if (recipientKey(entry) === wantedKey) return [...list];
    if (wantedEmail && emailOf(entry) === wantedEmail) return [...list];
  }
  return [...list, next];
}

/**
 * The sentence to show, or null when the set may be saved.
 *
 * An EMPTY dynamic group is not a problem here: it resolves at send time and
 * somebody may hold the role by then, which is the entire argument for having
 * dynamic groups at all. A malformed address is a problem now.
 */
export function recipientProblem(list: readonly RecipientDraft[]): string | null {
  const check = validateRecipientRows(list);
  if (check.ok) return null;
  const first = check.invalid[0];
  return first.value ? `${first.value} — ${first.reason}` : first.reason;
}

/** What one row of the dropdown offers. */
type Option =
  | { kind: "email"; value: string; label: string; hint: string }
  | { kind: "member"; value: string; label: string; hint: string; member: WorkspaceMember }
  | { kind: "group"; value: string; label: string; hint: string };

export function RecipientPicker({
  value,
  onChange,
  disabled = false,
  label,
  placeholder = "Name, email or group",
}: {
  value: readonly RecipientDraft[];
  onChange: (next: RecipientDraft[]) => void;
  disabled?: boolean;
  /** The visible label. Rendered by the caller when it has its own; passed
      here it becomes the field's accessible name. */
  label?: string;
  placeholder?: string;
}) {
  const fieldId = useId();
  const listId = `${fieldId}-list`;
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  /*
   * The roster loads on first OPEN, not on mount. A certificate cascade draws
   * six of these pickers at once and six mounts must not be six fetches — the
   * directory is a module-level store shared by every picker on the page, and
   * `enabled` is what defers the one request until somebody actually looks.
   */
  const directory = useAssigneeDirectory(open);
  const members = directory.members;

  const typed = search.trim();
  const options = useMemo<Option[]>(() => {
    const chosen = new Set(value.map(recipientKey));
    const rows: Option[] = [];

    /*
     * "Add typed@email.com" IS THE FIRST RESULT, which §6 states plainly. The
     * reason it has to be first rather than last: somebody typing a full
     * address has already decided, and making them arrow past four fuzzy
     * name matches to reach the thing they typed is the interaction that
     * makes people give up and paste addresses into the message body.
     *
     * It is suppressed when the address belongs to somebody on the roster —
     * that person is offered as themselves, with their name, which is the
     * better row and the one that keeps a user id on the record.
     */
    const normalised = normaliseRecipientEmail(typed);
    const onRoster = members.some(
      (member) => normaliseRecipientEmail(member.email) === normalised,
    );
    if (typed && isValidRecipientEmail(typed) && !onRoster && !chosen.has(`email:${normalised}`)) {
      rows.push({
        kind: "email",
        value: `email:${normalised}`,
        label: `Add ${typed}`,
        hint: "External address",
      });
    }

    for (const member of filterMembers(members, typed)) {
      if (chosen.has(`user:${member.id}`)) continue;
      rows.push({
        kind: "member",
        value: `user:${member.id}`,
        label: member.name,
        hint: member.email,
        member,
      });
    }

    const needle = typed.toLowerCase();
    for (const group of DYNAMIC_GROUPS) {
      if (chosen.has(`group:${group.key}`)) continue;
      if (needle && !`${group.label} ${group.description}`.toLowerCase().includes(needle)) continue;
      rows.push({
        kind: "group",
        value: `group:${group.key}`,
        label: group.label,
        hint: group.description,
      });
    }

    return rows;
  }, [members, typed, value]);

  /* The highlight is an INDEX into a list that changes as you type, so it is
     pulled back into range whenever the list shrinks — otherwise Enter after
     a narrowing keystroke selects nothing and looks broken. */
  useEffect(() => {
    setActive((current) => (current < options.length ? current : 0));
  }, [options.length]);

  /* Clicking away commits nothing and closes the list. Bound on the document
     because the click that dismisses this is by definition outside it. */
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [open]);

  const choose = (option: Option) => {
    const next: RecipientDraft =
      option.kind === "email"
        ? { userId: null, email: typed, groupKey: null }
        : option.kind === "member"
          ? { userId: option.member.id, email: null, groupKey: null }
          : { userId: null, email: null, groupKey: option.value.slice("group:".length) };
    onChange(addRecipient(value, next, members));
    setSearch("");
    setActive(0);
    /* The list stays open: adding recipients is nearly always adding several,
       and closing after each one costs a click per person. */
    inputRef.current?.focus();
  };

  const remove = (recipient: RecipientDraft) => {
    const key = recipientKey(recipient);
    onChange(value.filter((entry) => recipientKey(entry) !== key));
  };

  const commitTyped = () => {
    if (!typed) return;
    if (options.length) {
      choose(options[Math.min(active, options.length - 1)]);
      return;
    }
    /* No option matched, so this is a free-typed address. An invalid one is
       LEFT IN THE BOX rather than added and flagged: an address that never
       becomes a chip cannot be forgotten about, and the message under the
       field says why it did not take. */
    if (isValidRecipientEmail(typed)) {
      onChange(addRecipient(value, { userId: null, email: typed, groupKey: null }, members));
      setSearch("");
    }
  };

  const typedIsBadAddress = Boolean(typed) && options.length === 0 && !isValidRecipientEmail(typed);
  const problem = recipientProblem(value);

  return (
    <div className="recipient-picker" ref={rootRef}>
      <div
        className={`recipient-picker__field${disabled ? " is-disabled" : ""}`}
        /* The whole box is the click target, not just the 8px of input left
           over after four chips — a 44px row that only responds on part of
           itself is a 44px row in name only. */
        onClick={() => {
          if (!disabled) inputRef.current?.focus();
        }}
      >
        {value.map((recipient) => (
          <RecipientChip
            key={recipientKey(recipient)}
            recipient={recipient}
            members={members}
            disabled={disabled}
            onRemove={() => remove(recipient)}
          />
        ))}
        <input
          ref={inputRef}
          id={fieldId}
          className="recipient-picker__input"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={label ?? "Recipients"}
          aria-activedescendant={
            open && options.length ? `${listId}-${Math.min(active, options.length - 1)}` : undefined
          }
          autoComplete="off"
          disabled={disabled}
          value={search}
          placeholder={value.length ? "" : placeholder}
          onFocus={() => setOpen(true)}
          onChange={(changed) => {
            setSearch(changed.target.value);
            setOpen(true);
          }}
          onBlur={commitTyped}
          onKeyDown={(pressed) => {
            if (pressed.key === "ArrowDown") {
              pressed.preventDefault();
              setOpen(true);
              setActive((current) => (options.length ? (current + 1) % options.length : 0));
              return;
            }
            if (pressed.key === "ArrowUp") {
              pressed.preventDefault();
              setActive((current) =>
                options.length ? (current - 1 + options.length) % options.length : 0,
              );
              return;
            }
            if (pressed.key === "Enter" || pressed.key === "," || pressed.key === ";") {
              /* Enter must not reach a submit button, and comma/semicolon are
                 what a person pasting a list of addresses types between them. */
              if (typed || options.length) pressed.preventDefault();
              commitTyped();
              return;
            }
            if (pressed.key === "Backspace" && !search && value.length) {
              /* Backspace on an empty box removes the last chip — the one
                 gesture every chip input in existence has taught people. */
              pressed.preventDefault();
              remove(value[value.length - 1]);
              return;
            }
            if (pressed.key === "Escape" && open) {
              /*
               * STOPS HERE. The dialog around this listens for Escape on its
               * scrim and closes the whole modal; if this key kept bubbling,
               * dismissing a dropdown would throw away everything the reader
               * had typed into the form behind it. When the list is CLOSED the
               * key is left alone, so Escape still closes the dialog — the
               * behaviour that was broken once before on this dialog and must
               * not be broken again.
               */
              pressed.preventDefault();
              pressed.stopPropagation();
              setOpen(false);
            }
          }}
        />
      </div>

      {open ? (
        <ul className="recipient-picker__list" id={listId} role="listbox">
          {directory.loading && !members.length ? (
            <li className="recipient-picker__note">Loading the workspace roster…</li>
          ) : null}
          {directory.error ? (
            /* Never a silent empty list: a picker that shows nothing because a
               fetch failed looks like a workspace with no people in it. */
            <li className="recipient-picker__note recipient-picker__note--error">
              {directory.error}
            </li>
          ) : null}
          {options.map((option, index) => (
            <li key={option.value}>
              <button
                type="button"
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={`recipient-picker__option${index === active ? " is-active" : ""}`}
                /* mousedown, not click: the input's blur would otherwise fire
                   first, commit the typed text and re-render the list out from
                   under the pointer. */
                onMouseDown={(pressed) => {
                  pressed.preventDefault();
                  choose(option);
                }}
                onMouseEnter={() => setActive(index)}
              >
                <span className={`recipient-picker__glyph recipient-picker__glyph--${option.kind}`}>
                  {option.kind === "member" ? (
                    <span
                      className="recipient-chip__avatar"
                      style={{ background: memberColour(option.member) }}
                    >
                      {memberInitials(option.member)}
                    </span>
                  ) : (
                    <Icon name={option.kind === "group" ? "users" : "user"} size={15} />
                  )}
                </span>
                <span className="recipient-picker__text">
                  <strong>{option.label}</strong>
                  <em>{option.hint}</em>
                </span>
              </button>
            </li>
          ))}
          {!options.length && !directory.loading ? (
            <li className="recipient-picker__note">
              {typed
                ? "No match. Type a full email address to add somebody outside the workspace."
                : "Everyone available is already on this reminder."}
            </li>
          ) : null}
        </ul>
      ) : null}

      {typedIsBadAddress ? (
        <p className="recipient-picker__problem" role="alert">
          <Icon name="alert" size={13} />
          <span>“{typed}” is not a valid email address, so it has not been added.</span>
        </p>
      ) : null}
      {problem ? (
        <p className="recipient-picker__problem" role="alert">
          <Icon name="alert" size={13} />
          <span>{problem}</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * One chip.
 *
 * A GROUP reads differently from a PERSON — dashed edge, two-person glyph, and
 * a title saying when it is resolved — because those two things behave
 * differently on the day the reminder sends. See the file header.
 */
function RecipientChip({
  recipient,
  members,
  disabled,
  onRemove,
}: {
  recipient: RecipientDraft;
  members: readonly WorkspaceMember[];
  disabled: boolean;
  onRemove: () => void;
}) {
  if (recipient.groupKey) {
    const label = dynamicGroupLabel(recipient.groupKey);
    return (
      <span
        className="recipient-chip recipient-chip--group"
        title={`${label} — resolved when the reminder sends, not now.`}
      >
        <span className="recipient-chip__avatar recipient-chip__avatar--group" aria-hidden="true">
          <Icon name="users" size={13} />
        </span>
        <span className="recipient-chip__label">{label}</span>
        <span className="recipient-chip__kind">group</span>
        <ChipRemove label={label} disabled={disabled} onRemove={onRemove} />
      </span>
    );
  }

  const member = recipient.userId
    ? members.find((person) => person.id === recipient.userId)
    : undefined;
  /*
   * A user id the roster has not loaded yet still renders — as the id, not as
   * a blank chip. A recipient that vanishes while a fetch is in flight is a
   * recipient somebody will assume they never added.
   */
  const label = member?.name ?? recipient.email ?? recipient.userId ?? "";
  const title = member ? `${member.name} · ${member.email}` : label;

  return (
    <span className={`recipient-chip${member ? "" : " recipient-chip--external"}`} title={title}>
      {member ? (
        <span className="recipient-chip__avatar" style={{ background: memberColour(member) }}>
          {memberInitials(member)}
        </span>
      ) : (
        <span className="recipient-chip__avatar recipient-chip__avatar--external" aria-hidden="true">
          <Icon name="user" size={13} />
        </span>
      )}
      <span className="recipient-chip__label">{label}</span>
      <ChipRemove label={label} disabled={disabled} onRemove={onRemove} />
    </span>
  );
}

function ChipRemove({
  label,
  disabled,
  onRemove,
}: {
  label: string;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      className="recipient-chip__remove"
      aria-label={`Remove ${label}`}
      disabled={disabled}
      onClick={(pressed) => {
        /* The field's own click handler focuses the input; without this the
           removal would be followed by a focus jump that re-opens the list. */
        pressed.stopPropagation();
        onRemove();
      }}
    >
      <Icon name="close" size={12} />
    </button>
  );
}
