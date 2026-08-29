import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const VIEW = "app/(app)/portal/views/fix-tracker.tsx";
const CSS = "app/(app)/portal/views/fix-tracker.css";

/**
 * Stage 22 — the Maintenance Engineer Dashboard against its own data.
 *
 * Four of the things wrong with this screen were wrong against the database,
 * not merely plain, and each of them looked fine in a screenshot. What follows
 * pins the decisions that fixed them, and pins the constraint that the fix was
 * additive: every tab, control and panel section that existed before still
 * exists.
 *
 * The data-backed tests read the local D1 file directly. It is a development
 * artefact, so they skip rather than fail when it is absent — the same bargain
 * `stage-thirteen-css-split` makes with the build output.
 */

const D1 =
  ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/faaf2b0445ab934c3aac48ddf0cdfade8f9bac050be98993748742cdd2cb05fb.sqlite";

async function openBoardDatabase() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null; // Older Node without the built-in driver.
  }
  try {
    return new DatabaseSync(path.join(root, D1), { readOnly: true });
  } catch {
    return null; // No seeded development database on this machine.
  }
}

/* ── 1. The description is the headline ─────────────────────────────────── */

test("the card leads with the description, not the row's source label", async () => {
  const view = await read(VIEW);

  // `title` on this estate is monday's Name column, which the import filled
  // with the source of the row — "Manual", "Incoming form answer". It is the
  // fallback for a job with no description, never the headline.
  assert.match(
    view,
    /const headline = item\.description\?\.trim\(\) \|\| item\.title;/,
    "the card headline must be the description, falling back to the title",
  );
  assert.match(
    view,
    /className="fix-tracker__card-title"/,
    "the description needs its own class so it can be styled as the headline",
  );

  // Kept, demoted — the constraint was additive-only.
  assert.match(view, /fix-tracker__card-source/, "the source label must survive");

  const css = await read(CSS);
  assert.match(
    css,
    /\.fix-tracker__card-title \{[^}]*font-weight: 600;/,
    "the headline must be the weighted text on the card",
  );
  assert.match(
    css,
    /\.fix-tracker__card-source \{[^}]*font-size: 10px;/,
    "the source label must be the smallest text on the card",
  );
});

test("the panel is headed by the job, not by the word 'Manual'", async () => {
  const view = await read(VIEW);
  assert.match(
    view,
    /<h4>\{item\.description\?\.trim\(\) \|\| item\.title\}<\/h4>/,
    "a contractor opening a copied link must not be met with a dialog headed 'Manual'",
  );
});

/* ── 2. Age and overdue ─────────────────────────────────────────────────── */

test("the card says how old a job is and whether it has run past its due date", async () => {
  const view = await read(VIEW);
  for (const field of ["item.requestedAt", "item.dueAt", "item.completedAt"]) {
    assert.ok(view.includes(field), `timing must read ${field}`);
  }
  assert.match(view, /Overdue by \$\{humanDays\(-dueDays\)\}/);
  assert.match(view, /Raised \$\{humanDays\(ageDays\)\} ago/);

  // UTC, because the dates arrive as bare YYYY-MM-DD and local-time arithmetic
  // puts a job raised today at "1 day ago" for anyone west of Greenwich.
  assert.match(view, /Date\.UTC\(/, "day arithmetic must be done in UTC");
});

test("finished work is never flagged overdue, with or without a completion date", async () => {
  const view = await read(VIEW);
  assert.match(
    view,
    /const done = completed !== null \|\| jobState\(item\) === "completed";/,
    "the stage decides whether a job is done; the completion date is paperwork",
  );
  assert.match(view, /const overdue = !done &&/);

  const db = await openBoardDatabase();
  if (!db) return;
  try {
    // The reason the date alone is not enough: a large minority of the jobs the
    // board files as complete never had a completion date recorded, and judging
    // by the date put "Overdue by 41 months" in red on finished work.
    const [row] = db
      .prepare(
        "SELECT COUNT(*) AS n FROM maintenance_requests WHERE stage = 'Completed' AND completed_at IS NULL",
      )
      .all();
    assert.ok(
      row.n > 0,
      "this test guards a real case — completed jobs with no completion date",
    );
  } finally {
    db.close();
  }
});

/* ── 3. The tabs agree with the board ───────────────────────────────────── */

test("the tabs are decided by the board's stage, not by matching status text", async () => {
  const view = await read(VIEW);

  assert.match(
    view,
    /const stage = \(item as \{ stage\?: string \| null \}\)\.stage;/,
    "the tab split must key off the board's own grouping column",
  );
  assert.match(view, /if \(key === "booked"\) return "booked";/);
  assert.match(view, /if \(key === "completed"\) return "completed";/);

  // The status heuristic survives only as the fallback for an item that really
  // has no stage. If it ever becomes the primary test again, "Job Completed"
  // starts matching "completed" and the Jobs Booked tab fills with finished
  // work all over again.
  const stageBlock = view.slice(
    view.indexOf("function jobState"),
    view.indexOf("/** Kept for callers"),
  );
  assert.ok(
    stageBlock.indexOf("stage") < stageBlock.indexOf('status.includes("completed")'),
    "stage must be consulted before the status text",
  );
});

test("the tabs carry counts, and the booked count is the board's own group", async () => {
  const view = await read(VIEW);
  assert.match(view, /className="fix-tracker__tab-count"/);
  assert.match(view, /\{counts\[entry\.key\]\}/);

  const db = await openBoardDatabase();
  if (!db) return;
  try {
    /*
     * The correspondence the tab is named after: the board's "Jobs Booked"
     * group holds exactly the rows whose stage is "Booked". Nothing else on
     * this board makes that promise — several groups mix stages — which is why
     * `stage = 'Booked'` is the right question and "does the status contain the
     * word booked" was not.
     */
    const [group] = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM maintenance_group_items gi
           JOIN maintenance_groups g ON g.id = gi.group_id
          WHERE g.name = 'Jobs Booked'`,
      )
      .all();
    const [stage] = db
      .prepare("SELECT COUNT(*) AS n FROM maintenance_requests WHERE stage = 'Booked'")
      .all();
    const [both] = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM maintenance_group_items gi
           JOIN maintenance_groups g ON g.id = gi.group_id
           JOIN maintenance_requests r ON r.id = gi.request_id
          WHERE g.name = 'Jobs Booked' AND r.stage = 'Booked'`,
      )
      .all();
    assert.equal(group.n, stage.n, "the Jobs Booked group and stage must agree");
    assert.equal(both.n, stage.n, "and must be the same rows");

    // And the reason the old heuristic could not find them: not one booked job
    // has a status containing any of the four words it looked for.
    const [heuristic] = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM maintenance_requests
          WHERE stage = 'Booked'
            AND (lower(status) LIKE '%scheduled%'
              OR lower(status) LIKE '%in progress%'
              OR lower(status) LIKE '%completed%'
              OR lower(status) LIKE '%booked%')`,
      )
      .all();
    assert.equal(
      heuristic.n,
      0,
      "the status text cannot identify a booked job on this board",
    );
  } finally {
    db.close();
  }
});

/* ── 4. Photographs ─────────────────────────────────────────────────────── */

test("a photograph is classified by its board column, not only by its kind", async () => {
  const view = await read(VIEW);
  assert.match(
    view,
    /column\.endsWith\("issuePictures"\)/,
    "issue pictures must be recognised by the column the import writes",
  );
  assert.match(view, /column\.endsWith\("completedPictures"\)/);
  // `kind` still counts: it is what a fresh upload through /api/files sets.
  assert.match(view, /file\.kind === "issue" \|\|/);
  assert.match(view, /file\.kind === "completion" \|\|/);
  assert.match(
    view,
    /boardColumnId: string \| null;/,
    "the field has to be on the type before it can be read",
  );
});

test("cards show whether a job has photographs, and thumbnails are thumbnails", async () => {
  const view = await read(VIEW);
  assert.match(view, /item\.attachmentCount \?\? 0/);
  assert.match(view, /plural\(count, "photo"\)/);

  // Every image request on this screen asks for the derivative. These are
  // camera JPEGs off a phone and the panel used to load a dozen originals at
  // once.
  // One `src={…}` per line, so the line is the unit — a `[^}]+` capture stops
  // at the first brace inside the template literal and proves nothing.
  const sources = [...view.matchAll(/^.*\bsrc=\{.*$/gm)].map((match) => match[0].trim());
  assert.ok(sources.length >= 2, "expected the card strip and the gallery");
  for (const source of sources) {
    assert.match(source, /\?thumb=1/, `image source ${source} must request a thumbnail`);
  }
});

test("card thumbnails are fetched only for cards on screen", async () => {
  const view = await read(VIEW);
  // The Completed tab draws hundreds of cards; one /api/files call each, on
  // mount, is not something a shop phone survives.
  assert.match(view, /new IntersectionObserver\(/);
  assert.match(view, /const attachmentCache = new Map<string, Promise<Attachment\[\]>>\(\);/);
  assert.match(
    view,
    /attachmentCache\.delete\(key\)/,
    "a failed lookup must not be cached as 'this job has no photographs'",
  );
  assert.match(
    view,
    /attachmentCache\.delete\(`\$\{item\.id\}:100`\)/,
    "an upload must invalidate the gallery it would otherwise not appear in",
  );
});

/* ── 5. The phone in the shop ───────────────────────────────────────────── */

test("every control on this screen clears the 44px touch minimum", async () => {
  const css = await read(CSS);
  for (const rule of [
    /\.fix-tracker \.fix-tracker__tabs button \{[^}]*min-height: 44px;/,
    /\.fix-tracker \.fix-tracker__search input,[^{]*\{[^}]*min-height: 44px;/,
    /\.fix-tracker__panel \.icon-button,[^{]*\{[^}]*min-height: 44px;/,
    /\.fix-tracker__panel input\[type="date"\],[^{]*\{[^}]*min-height: 44px;/,
    /\.fix-tracker__files a \{[^}]*min-height: 44px;/,
  ]) {
    assert.match(css, rule, `missing a 44px minimum: ${rule}`);
  }
});

test("nothing on this screen can force the page wider than the phone", async () => {
  const css = await read(CSS);
  // A flat 280px track inside a pane narrower than 280px is a horizontal
  // scrollbar, and the pane is narrower than the viewport once the sidebar and
  // its padding are taken out.
  assert.match(
    css,
    /repeat\(auto-fill, minmax\(min\(280px, 100%\), 1fr\)\)/,
    "the card grid must not demand a fixed minimum track width",
  );
  assert.match(
    css,
    /\.fix-tracker__photo-strip \{[^}]*overflow: hidden;/,
    "the thumbnail strip must clip rather than push the card wide",
  );
  assert.doesNotMatch(
    css,
    /^\s*(?:min-)?width:\s*\d{3,}px;/m,
    "no fixed three-figure width belongs in a view used at 390px",
  );
});

/* ── 6. Additive only ───────────────────────────────────────────────────── */

test("every tab, control and panel section that existed before still exists", async () => {
  const view = await read(VIEW);
  for (const label of [
    "Maintenance Engineer Dashboard",
    "Incoming Requests",
    "Jobs Booked",
    "Search by description",
    "All Locations",
    "Copy Link",
    "Issue Pictures",
    "Upload Completed Work Picture",
    "Date Completed",
    "Add Comment",
    "Submit Comment",
    "Location",
    "Engineer Type",
    "Priority",
    "Status",
    "Date Requested",
    "Requested By",
    "Description",
  ]) {
    assert.ok(view.includes(label), `"${label}" must not have been removed`);
  }

  // And the writes still go through the board's own endpoints.
  assert.match(view, /"\/api\/maintenance"/);
  assert.match(view, /uploadEvidenceFile/);
  assert.match(view, /kind: "completion"/);
  assert.match(view, /onChanged\?\.\(\)/);
});

test("a write here reaches the board, even though nobody passes onChanged", async () => {
  const view = await read(VIEW);
  assert.match(
    view,
    /window\.dispatchEvent\(new Event\("maintsupp:refresh-board"\)\)/,
    "the Fix Tracker must announce its writes on the app's own refresh channel",
  );
  // Every write path goes through the one announcement, so none of the three
  // can be added later without it.
  assert.equal(
    view.match(/announceChange\(onChanged\)/g)?.length,
    3,
    "the completion date, the comment and the upload must all announce",
  );

  // The channel is real: live-board listens for it, and it is what portal-app
  // fires after saving a comment for the same reason.
  const board = await read("app/(app)/portal/live-board.tsx");
  assert.match(
    board,
    /addEventListener\("maintsupp:refresh-board"/,
    "the event this view fires must still be one the board listens for",
  );

  // And the reason it is needed: the view pane hands `onChanged` straight from
  // `onFormSubmitted`, which live-board does not supply. The pane was part of
  // `board-chrome.tsx` when this was written and is now `board-view-pane.tsx`.
  const pane = await read("app/(app)/portal/board-view-pane.tsx");
  assert.match(pane, /<FixTrackerView items=\{items\} palette=\{palette\} onChanged=\{onFormSubmitted\}/);
});

test("the view's stylesheet is its own file, and brand-overrides keeps the original block", async () => {
  const view = await read(VIEW);
  assert.match(view, /import "\.\/fix-tracker\.css";/);

  // The original block is left where it is. stage-sixteen asserts the scrim
  // rule lives in brand-overrides.css, and that file is edited by several
  // people at once — this change adds a file rather than rewriting theirs.
  const brand = await read("app/brand-overrides.css");
  assert.match(brand, /\.fix-tracker__overlay \.modal-scrim \{\s*z-index: 0;/);
  assert.match(brand, /\.fix-tracker__panel \{/);
});

/* ── 7. The link the Copy Link button promises ──────────────────────────── */

test("a copied job link opens the job it names", async () => {
  const view = await read(VIEW);
  /*
   * The button used to write `?item=<id>` on the portal's own URL — a link
   * that demanded a login from a store manager or landlord it was sent to. It
   * now mints a token on the contractor-link infrastructure and copies the
   * public /j/:token URL, which opens the job it names with no account at all.
   *
   * THE GRANT CHANGED, on the owner's explicit instruction. It was `viewer` —
   * read-only by construction — and the owner cancelled that rule outright:
   * the Fix Tracker link must offer the same working job page as a contractor
   * link, uploads, dates, signature and completion included. Minting
   * `contractor` is the whole of how that was done, which is deliberate: the
   * permission model is the proven one rather than a second, parallel set of
   * rules that would have to be kept safe separately.
   *
   * The `viewer` audience is NOT weakened by this and is still forced
   * read-only at mint and at resolve — see stage-thirty — so links already in
   * circulation keep the grant they were issued with. Nothing mints one now.
   */
  assert.match(view, /audience: "contractor"/);
  assert.doesNotMatch(
    view,
    /audience: "viewer"/,
    "the Fix Tracker link is a working link; the owner cancelled the read-only rule",
  );
  assert.match(view, /fetch\("\/api\/board\/links"/);
  assert.doesNotMatch(
    view,
    /url\.searchParams\.set\("item", item\.id\)/,
    "the copied link must be the public ticket, not a portal address behind a login",
  );
  // The internal `?item=` deep link is still honoured for anyone arriving
  // with one — and still consumed, not left to reopen the panel forever.
  assert.match(view, /new URL\(window\.location\.href\)\.searchParams\.get\("item"\)/);
  assert.match(
    view,
    /url\.searchParams\.delete\("item"\)/,
    "the parameter must be consumed, not left to reopen the panel forever",
  );
});

/* ── 8. Corrupt data is not dressed up as a priority ────────────────────── */

test("'[object Object]' is not rendered in a coloured pill", async () => {
  const view = await read(VIEW);
  assert.match(view, /text === "\[object Object\]"/);
  assert.match(view, /const priority = chipLabel\(item\.priority\);/);
  assert.match(view, /const status = chipLabel\(item\.status\);/);

  const db = await openBoardDatabase();
  if (!db) return;
  try {
    // Real rows, from the importer. The view treats them as a missing value;
    // recovering them is the importer's job, not this screen's.
    const [row] = db
      .prepare(
        "SELECT COUNT(*) AS n FROM maintenance_requests WHERE priority = '[object Object]'",
      )
      .all();
    assert.ok(row.n > 0, "this guard exists because the rows exist");
  } finally {
    db.close();
  }
});
