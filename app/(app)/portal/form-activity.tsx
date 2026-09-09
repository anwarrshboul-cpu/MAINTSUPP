"use client";

import { Icon } from "../../components";
import type { FormChange } from "./form-builder-save";

/**
 * THE FORM'S ACTIVITY LOG.
 *
 * ── WHAT IT HONESTLY IS, AND WHAT IT IS NOT ───────────────────────────────
 *
 * It is every change this editor has PERSISTED since it was opened, newest
 * first, with what changed and when. It is not the form's whole history, and
 * the panel says so in as many words at the foot of the list.
 *
 * The reason is worth stating rather than hiding: `PATCH /api/board/form`
 * writes no audit event. `recordAudit()` exists, `activity_log` exists, and the
 * form route calls neither — so there is no record anywhere of who changed a
 * form or when. A panel that presented itself as "the form's history" while
 * quietly starting from zero on every page load would be worse than no panel:
 * an empty list would read as "nobody has touched this form", which is a claim
 * this build cannot make.
 *
 * What it CAN answer is the question people actually ask an autosaving editor —
 * "did that go through, and what exactly did I change?" — and it answers it
 * from the same record Undo uses, so the two can never disagree. Entries are
 * appended at exactly the moment, and under exactly the condition, that a
 * history step is pushed: the server answered, and the definition genuinely
 * moved. A save that failed is not here; nor is one that changed nothing a
 * person can see; nor is a submission arriving between two saves.
 *
 * ── NO RESTORE BUTTON, DELIBERATELY ───────────────────────────────────────
 *
 * Undo already restores, is board-scoped, keeps at least twenty steps, is
 * chronological across overlapping saves and is covered by 35 tests. A second
 * restore path that jumped N steps would have to truncate the same stack, and
 * it would be a second implementation of the one thing in this editor that is
 * genuinely hard to get right. This lists; the toolbar's Undo restores.
 */

/** The PATCH's section names, as a person would say them. */
const SECTION_NAMES: Readonly<Record<string, string>> = {
  title: "the form's title",
  description: "the form's description",
  active: "whether the link is live",
  requireLogin: "the sign-in requirement",
  responseLimit: "the response limit",
  closeAt: "the close date",
  questions: "the questions",
  order: "the order of the questions",
  features: "the settings",
  appearance: "the design",
  accessibility: "the language and accessibility settings",
  tags: "the tags",
};

function describe(change: FormChange): string {
  if (change.undone) return "Undo — the previous saved version was restored";
  if (!change.sections.length) return "Saved";
  const named = change.sections.map((section) => SECTION_NAMES[section] ?? section);
  if (named.length === 1) return `Changed ${named[0]}`;
  const last = named[named.length - 1];
  return `Changed ${named.slice(0, -1).join(", ")} and ${last}`;
}

/**
 * The clock, in the reader's own locale.
 *
 * `en-GB` is NOT forced here, unlike the board's date columns: this is a
 * wall-clock time for the person sitting in front of the editor, not a stored
 * value anybody will compare across machines. Falls back to a plain ISO time if
 * the environment has no `Intl`, which is the one thing that must not throw
 * inside a render.
 */
function clockOf(at: number): string {
  const when = new Date(at);
  try {
    return when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return when.toISOString().slice(11, 16);
  }
}

export default function FormActivity({
  log,
  canUndo,
}: {
  log: FormChange[];
  /** Whether the toolbar's Undo would do anything — named, not re-implemented. */
  canUndo: boolean;
}) {
  return (
    <div className="form-panel form-panel--activity">
      <section className="form-panel__section">
        <h3>
          <Icon name="activity" size={15} /> Activity
        </h3>
        <div className="form-panel__body">
          {log.length === 0 ? (
            <p className="form-panel__static">
              <strong>Nothing has been saved yet in this session.</strong>
              <span>
                Every change is saved as you make it, and each one appears here with what it
                changed.
              </span>
            </p>
          ) : (
            <ol className="form-activity">
              {log.map((change, position) => (
                <li key={change.id} data-kind={change.undone ? "undo" : "change"}>
                  <span className="form-activity__mark" aria-hidden="true">
                    <Icon name={change.undone ? "refresh" : "check"} size={12} />
                  </span>
                  <span className="form-activity__what">{describe(change)}</span>
                  <time className="form-activity__when" dateTime={new Date(change.at).toISOString()}>
                    {clockOf(change.at)}
                  </time>
                  {position === 0 && canUndo && !change.undone && (
                    <em className="form-activity__tip">Undo goes back to before this</em>
                  )}
                </li>
              ))}
            </ol>
          )}
          <p className="form-panel__note">
            This is what has been saved from this editor since it was opened. The workspace does
            not yet keep a permanent record of form changes, so closing the tab clears the list —
            the form itself is saved either way.
          </p>
        </div>
      </section>
    </div>
  );
}
