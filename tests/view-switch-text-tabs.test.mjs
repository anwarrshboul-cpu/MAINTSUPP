import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * `.view-switch` carries two different controls, and only one of them is square.
 *
 * THE BUG THIS PINS. The class was written for a two-button grid/list toggle:
 * `.view-switch button` is a fixed `30x30` box with `padding: 0`, and the
 * touch-target rule in brand-overrides.css widens that to a fixed `44x44`
 * below 768px. Three screens reuse the class for a strip of TEXT tabs, and a
 * word does not fit in a 30px square with no padding — "Identity", "Address",
 * "Contacts", "Access", "Opening", "Lease" and "Reconciliation" overflowed
 * their boxes and printed on top of one another in the site editor.
 *
 * The distinguishing signal is in the markup and not derivable in CSS: a text
 * strip is the one with `role="tablist"` and words inside its buttons, and an
 * icon toggle has neither. So the strips opt out with a modifier, and this
 * test is what keeps a fourth one from being added without it.
 */

async function tsxFiles(dir, found = []) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const next = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await tsxFiles(next, found);
    else if (entry.name.endsWith(".tsx")) found.push(next);
  }
  return found;
}

test("every text tab strip opts out of the icon toggle's square", async () => {
  const files = await tsxFiles("app/(app)");
  const missing = [];
  const textStrips = [];

  for (const file of files) {
    const source = await read(file);
    for (const match of source.matchAll(/<div className="([^"]*view-switch[^"]*)"([^>]*)>/g)) {
      const [, className, rest] = match;
      // A tablist is the text strip; the grid/list toggles are neither
      // tablists nor worded.
      if (!rest.includes('role="tablist"')) continue;
      textStrips.push(file);
      if (!className.includes("view-switch--text")) missing.push(`${file} — ${className}`);
    }
  }

  /*
   * TWO literals, not three, and the coverage is unchanged.
   *
   * This counts `<div className="…view-switch…" role="tablist">` written out in
   * a .tsx file. Workstream 5 gave the Sites editor and the Site detail screen
   * one shared `SectionTabs` component instead of a strip written twice, so the
   * three literals became two — options-admin, and section-tabs itself. Every
   * strip that renders is still scanned, because the shared component's own
   * literal is in this directory and is checked like any other.
   *
   * The guard that matters is `missing` below: it names any text strip lacking
   * `view-switch--text`, and it is asserted empty regardless of the count. This
   * line only exists so the regex silently matching NOTHING cannot pass as
   * success — which is why it is a floor rather than an equality.
   */
  assert.ok(textStrips.length >= 2, `expected the known text strips, found ${textStrips.length}`);
  assert.deepEqual(
    missing,
    [],
    `these are text tabs inside a 30px icon box, so the words overlap:\n  ${missing.join("\n  ")}`,
  );
});

test("the modifier actually unsets the fixed box, in both size regimes", async () => {
  const css = await read("app/brand-overrides.css");

  const base = css.slice(css.indexOf(".view-switch--text button {"));
  assert.ok(base.startsWith(".view-switch--text button {"), "the modifier must style the buttons");
  const block = base.slice(0, base.indexOf("}"));
  assert.match(block, /width: auto;/, "a word decides the width, not a 30px square");
  assert.match(block, /padding: 0 12px;/, "the base rule sets padding: 0, which leaves no room for text");
  assert.match(block, /white-space: nowrap;/, "a two-word tab must not break mid-label");

  /*
   * The mobile rule is the one that actually bites: it is LATER in the file and
   * sets a fixed 44x44, so a modifier that only overrode the 30px base would
   * still collapse every tab on a phone.
   */
  const mobile = css.slice(css.lastIndexOf(".view-switch--text button {"));
  assert.notEqual(
    css.indexOf(".view-switch--text button {"),
    css.lastIndexOf(".view-switch--text button {"),
    "there must be a mobile override too, or the 44x44 rule wins below 768px",
  );
  const mobileBlock = mobile.slice(0, mobile.indexOf("}"));
  assert.match(mobileBlock, /width: auto;/);
  assert.match(mobileBlock, /min-height: 44px;/, "the touch target is kept — it is the height that matters");

  assert.ok(
    css.lastIndexOf(".view-switch--text button {") > css.lastIndexOf("  .view-switch button {"),
    "the override must come after the 44x44 rule it is overriding",
  );
});

test("the two icon toggles keep their square", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const toggles = [...portal.matchAll(/<div className="([^"]*view-switch[^"]*)"([^>]*)>/g)];
  assert.equal(toggles.length, 2, "the board view and document view toggles");
  for (const [, className, rest] of toggles) {
    assert.ok(!rest.includes('role="tablist"'), "an icon toggle is not a tablist");
    assert.ok(
      !className.includes("view-switch--text"),
      "an icon toggle must keep the 30x30 box the class was written for",
    );
  }
});
