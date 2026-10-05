/**
 * A LONDON PAGE'S PICTURE, CHOSEN IN THE MEDIA LIBRARY BY ITS TITLE.
 *
 * The London pages are written in the build (`app/(marketing)/_landing`), each
 * with a photograph from the approved pack. The owner asked to change those
 * pictures himself, from the console, without a release. The media library
 * (decision K) is already where the website's pictures are uploaded, replaced,
 * described and served from, so the library is the control and the TITLE is the
 * choice: an image whose title is a London page's address — `/london/brent-cross`
 * — is that page's picture.
 *
 * WHY A TITLE AND NOT A PICKER. A picker needs somewhere to keep the choice: a
 * stored document, a save route, an editor screen and a migration, for one
 * field per page. The title is a field the library already has, validates and
 * shows, and the rule fits in the one sentence printed beside it. Nothing new is
 * stored, so there is nothing to migrate and nothing that can disagree with the
 * library.
 *
 * WHAT A PAGE NEEDS BEFORE IT USES ONE: an image, with a current file, and ALT
 * TEXT. A picture nobody has described is not drawn — the rule the homepage's
 * hero already follows — and the page keeps the photograph it ships with.
 *
 * TWO IMAGES WITH ONE TITLE. One still in the library beats an archived one, and
 * after that the most recently changed wins. Archiving alone does not take a
 * picture off a page: the library's own promise is that an archived asset keeps
 * working where it is used. To stop using one, change its title or delete it —
 * the page then draws its shipped photograph again.
 *
 * Pure: no database, no React. `page-pictures-public.ts` wires it to the cache.
 */

/** What the library knows about one image, before any file is resolved. */
export type TitledImage = {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  /** False while a first upload has not completed: there is nothing to draw. */
  hasFile: boolean;
};

/** A library image as a page draws it. */
export type PagePicture = { src: string; alt: string; width: number | null; height: number | null };

/** The resolved fields this module reads — `RenderableMedia` satisfies it. */
type ResolvedImage = { kind: string; alt: string | null; src: string; width: number | null; height: number | null };

const PAGE_PATH = /^\/london(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

/**
 * The page address a library title names, or null when it names none.
 *
 * Forgiving about how an address gets typed or pasted — capitals, a trailing
 * slash, the whole `https://maintsupp.com/...` link — and strict about what it
 * is: `/london` or one page under it. Any other title is an ordinary title.
 */
export function pagePathFromTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const path = title
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:www\.)?maintsupp\.com/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  return PAGE_PATH.test(path) ? path : null;
}

/** Which image each page address gets: `path -> media id`. See the header for the tie-break. */
export function choosePagePictures(rows: readonly TitledImage[]): Map<string, string> {
  const best = new Map<string, TitledImage>();
  for (const row of rows) {
    if (!row.hasFile) continue;
    const path = pagePathFromTitle(row.title);
    if (!path) continue;
    const held = best.get(path);
    if (!held || outranks(row, held)) best.set(path, row);
  }
  return new Map([...best].map(([path, row]) => [path, row.id]));
}

function outranks(candidate: TitledImage, held: TitledImage): boolean {
  const live = (row: TitledImage) => (row.status === "archived" ? 0 : 1);
  if (live(candidate) !== live(held)) return live(candidate) > live(held);
  return candidate.updatedAt > held.updatedAt;
}

/**
 * The chosen images a page may actually draw: an image, with alt text. A video
 * titled like a page, an image with no description, and an asset deleted
 * between the two reads are all left out, and the page keeps its own picture.
 */
export function drawablePagePictures(
  chosen: ReadonlyMap<string, string>,
  media: ReadonlyMap<string, ResolvedImage>,
): Map<string, PagePicture> {
  const out = new Map<string, PagePicture>();
  for (const [path, id] of chosen) {
    const asset = media.get(id);
    const alt = asset?.alt?.trim();
    if (!asset || asset.kind !== "image" || !alt) continue;
    out.set(path, { src: asset.src, alt, width: asset.width, height: asset.height });
  }
  return out;
}
