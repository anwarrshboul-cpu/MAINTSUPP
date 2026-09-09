import type { StoredFormConfig } from "../../lib/form-config";
import { questionsOf } from "./form-pages";

/**
 * The shape `/api/board/form` returns, shared by the builder shell, the three
 * panels and the Share dialog.
 *
 * It lives in its own module rather than in the shell because every one of
 * those four files needs it and three of them are client components: importing
 * the type from the shell would drag the shell's imports into the dialog's
 * bundle for the sake of a type that erases at build time.
 */
export type BuilderForm = {
  id: string;
  /** The register this form belongs to. Sent so the shell never has to guess. */
  boardKey?: string;
  /**
   * Whether `FormView` — which posts to `/api/maintenance` and takes no board
   * — would file its answer onto THIS register.
   *
   * Answered by the server, where `DEFAULT_BOARD_KEY` is defined. The shell
   * mounts the live fillable form only when it is true; on any other register
   * that component would draw the job board's questions with a Submit that
   * filed the job somewhere else.
   */
  filesIntoThisBoard?: boolean;
  title: string;
  description: string | null;
  active: boolean;
  requireLogin: boolean;
  hasPassword: boolean;
  responseLimit: number | null;
  closeAt: string | null;
  responseCount: number;
  shareToken: string;
  shortToken: string | null;
  /** The long link, always. */
  shareUrl: string;
  /** What the Share dialog shows and copies — long or short, per the switch. */
  presentedUrl: string;
  config: StoredFormConfig;
  /**
   * The canonical option substitution — live sites for Location, the option
   * registry for Engineer and Priority — exactly as `/api/forms/[token]`
   * serves it, because both endpoints build it with `formOptionOverrides`.
   * Preview projects with it; the Edit panel lists from it.
   */
  optionOverrides?: Record<string, Array<{ label: string; value: string }>>;
};

/**
 * Which builder surface is open. `view` is the live, fillable form.
 *
 * `activity` is the fifth and is a READ: what this editor has saved since it
 * was opened. It is a mode rather than a drawer because it has to be reachable
 * on a phone, where a drawer over a 375px canvas is the whole screen anyway.
 */
export type BuilderMode =
  | "view"
  | "edit"
  | "design"
  | "settings"
  | "preview"
  | "activity";

/**
 * The glyph beside a question in the Content list and on each canvas card.
 *
 * monday colours these by column type. The mapping is by the question's own
 * type rather than by its title, so a renamed question keeps the right glyph.
 */
export function questionGlyph(type: string) {
  switch (type) {
    case "SingleSelect":
      return { icon: "list", tone: "select" } as const;
    case "ShortText":
    case "LongText":
      return { icon: "document", tone: "text" } as const;
    case "Number":
      return { icon: "chart", tone: "number" } as const;
    case "Date":
    case "DateRange":
      return { icon: "calendar", tone: "date" } as const;
    case "File":
      return { icon: "image", tone: "file" } as const;
    case "People":
      return { icon: "users", tone: "people" } as const;
    case "Subitems":
      return { icon: "list", tone: "subitems" } as const;
    default:
      return { icon: "document", tone: "text" } as const;
  }
}

/**
 * The questions in the order the form draws them.
 *
 * DELEGATES rather than duplicating. This used to be its own walk of `order`
 * and `questions`, and it was correct — but the Edit surface now needs the SAME
 * walk with the page blocks left IN (they are what a page is), so the rule
 * moved to `questionsOf`/`orderedEntries` in `form-pages.ts` where both
 * readings come off one implementation. Two walks of the same array is how a
 * question ends up on the canvas and not in the Content rail.
 *
 * The behaviour is unchanged: monday's `sortedQuestionsList` first, then
 * anything the order forgot — so a question that exists but is unordered is
 * shown at the end rather than vanishing — and the page block dropped, because
 * it is a container and monday does not list it as a question.
 */
export function orderedQuestions(config: StoredFormConfig) {
  return questionsOf(config);
}
