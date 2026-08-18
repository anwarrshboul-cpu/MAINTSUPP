import type { StoredFormConfig } from "../../lib/form-config";

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
};

/** Which builder surface is open. `view` is the live, fillable form. */
export type BuilderMode = "view" | "edit" | "design" | "settings" | "preview";

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
 * Mirrors `publicForm()` on the server — monday's `sortedQuestionsList` first,
 * then anything the order forgot, so a question that exists but is unordered is
 * shown at the end rather than vanishing from the builder. The page block is
 * dropped: it is a container, and monday does not list it as a question.
 */
export function orderedQuestions(config: StoredFormConfig) {
  const byId = new Map(config.questions.map((question) => [question.id, question]));
  const ordered: StoredFormConfig["questions"] = [];
  for (const id of config.order) {
    const question = byId.get(id);
    if (question) {
      ordered.push(question);
      byId.delete(id);
    }
  }
  for (const remaining of byId.values()) ordered.push(remaining);
  return ordered.filter((question) => question.type !== "PAGE_BLOCK");
}
