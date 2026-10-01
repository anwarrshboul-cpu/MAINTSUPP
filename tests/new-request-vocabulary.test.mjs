/**
 * QA 2026-10-01: New request offered hard-coded Priority ("Urgent, High,
 * Medium, Low") and Category lists. A value the workspace does not configure is
 * snapped to its fallback on save (`submission-service.ts`), so a job raised as
 * High / Plumbing was saved as Medium / Other. Both lists now come from
 * `/api/context`'s requestConfiguration, as Trade already did.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("New request offers the workspace's own priorities and labels", async () => {
  const app = await readFile(new URL("../app/(app)/portal/portal-app.tsx", import.meta.url), "utf8");
  const modal = app.slice(app.indexOf("function CreateRequestModal("));
  assert.match(modal, /priorityChoices\.map\(\(choice\) =>/);
  assert.match(modal, /categoryChoices\.map\(\(choice\) =>/);
  assert.doesNotMatch(modal.slice(0, 12000), /<option>High<\/option>/);
  assert.match(app, /priorities=\{runtimeContext\?\.requestConfiguration\?\.priorities \?\? \[\]\}/);
  assert.match(app, /categories=\{runtimeContext\?\.requestConfiguration\?\.categories \?\? \[\]\}/);
});
