/**
 * The owner's rule (2026-10-06): "the majority of the settings should be only
 * for us, the owners or the admins". A client reads, exports and reports faults;
 * workspace configuration is MAINTSUPP's.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");

test("a client's default capabilities stay read, export, report a fault and arrange their own sidebar", async () => {
  const permissions = await read("app/lib/permissions.ts");
  /* Re-pointed 2026-10-06: the owner then let clients ADD columns, groups,
     compliance requirements and contractors (`board.add`) — still never edit,
     rename, delete or change settings. */
  assert.match(permissions, /client: \["board\.view", "board\.add", "requests\.create", "data\.export", "navigation\.personalise"\]/);
});

test("scheduled report emails are configuration: settings.edit, not data.export", async () => {
  for (const file of ["app/api/reports/schedules/route.ts", "app/api/reports/schedules/run/route.ts"]) {
    const source = await read(file);
    assert.match(source, /scopedDbWithCapability\(request, "settings\.edit"\)/);
    assert.doesNotMatch(source, /scopedDbWithCapability\(request, "data\.export"\)/);
  }
});

test("the Settings screen's targets cannot be typed into without settings.edit", async () => {
  const app = await read("app/(app)/portal/portal-app.tsx");
  assert.match(app, /aria-label=\{`\$\{option\.value\} SLA`\}\s*disabled=\{!canEditSettings\}/);
  assert.match(app, /aria-label="Compliance warning window in days"\s*disabled=\{!canEditSettings\}/);
});

/* Owner decision 2026-10-06 (second): "let them be allowed" — a client may ADD
   columns, groups, compliance requirements and contractors, and move groups.
   Verified locally as a client: create_group 201, create_column 201,
   move_group 200; rename_group and delete_items 403. */
test("board.add reaches only the additive actions; everything else still needs board.edit", async () => {
  const board = await read("app/api/board/route.ts");
  const set = board.slice(board.indexOf("const BOARD_ADD_ACTIONS"), board.indexOf("]);", board.indexOf("const BOARD_ADD_ACTIONS")));
  for (const action of ["create_group", "create_column", "duplicate_column", "create_option", "move_group"]) {
    assert.match(set, new RegExp(`"${action}"`), action);
  }
  for (const action of ["rename_group", "delete_group", "update_group", "delete_column", "clear_column", "update_column", "update_cell", "delete_items", "archive_items"]) {
    assert.doesNotMatch(set, new RegExp(`"${action}"`), `${action} stays board.edit`);
  }
  assert.equal(
    (board.match(/if \(!BOARD_ADD_ACTIONS\.has\(action\)\) \{\s*const editGuard = await scopedDbWithCapability\(request, "board\.edit"\);\s*if \(editGuard\.denied\) return editGuard\.denied;/g) ?? []).length,
    2,
    "POST and PATCH both re-check board.edit for anything not additive",
  );
  const workspace = await read("app/api/workspace/route.ts");
  assert.match(workspace, /const WORKSPACE_ADD_CAPABILITY: Record<string, Capability> = \{\s*compliance: "board\.add",\s*contractor: "board\.add",\s*\};/);
  /* Only the create path passes it: PATCH and DELETE stay sites.edit. */
  assert.equal((workspace.match(/WORKSPACE_ADD_CAPABILITY\[entity/g) ?? []).length, 1);
  const drawer = await read("app/(app)/portal/workspace-data-manager.tsx");
  assert.match(drawer, /const editorOpen = !readOnlyTab \|\| \(mayCreate && editorId === null\);/, "a new record only, never an existing one");
});
