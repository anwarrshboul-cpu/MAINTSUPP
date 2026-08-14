import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dataRoutes = [
  "app/api/board/route.ts",
  "app/api/context/route.ts",
  "app/api/files/route.ts",
  "app/api/files/[id]/route.ts",
  "app/api/files/multipart/route.ts",
  "app/api/leads/route.ts",
  "app/api/maintenance/route.ts",
  "app/api/notifications/route.ts",
  "app/api/workspace/route.ts",
];

test("all data APIs resolve an organisation-scoped database", async () => {
  for (const path of dataRoutes) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    /*
     * `scopedDb(request, { allowAnonymous: true })` counts too.
     *
     * What this test is about is that the organisation comes from `scopedDb`
     * and never from the request. Two routes are genuinely public — the lead
     * form has no account behind it, and a contractor uploading from a job
     * link proves themselves with that token — so they pass an option and then
     * do their own checking. They still resolve their organisation the same
     * way, which is the property being asserted.
     */
    assert.match(
      source,
      /scopedDb(WithCapability)?\(\s*request/,
      `${path} must resolve its scope through scopedDb`,
    );
    assert.doesNotMatch(source, /\bCLIENT_ID\b/, `${path} must not use a fixed client ID`);
    assert.doesNotMatch(source, /clientId\s*:/, `${path} must write organisationId`);
  }
});

test("the Stage 1 migration backfills every existing tenant table", async () => {
  const migration = await readFile(
    new URL("../drizzle/0006_stage_one_foundation.sql", import.meta.url),
    "utf8",
  );
  const tables = [
    "sites",
    "units",
    "maintenance_requests",
    "planned_maintenance",
    "quotations",
    "invoices",
    "system_notifications",
    "leads",
    "activity_log",
    "attachments",
    "compliance_documents",
    "workspace_settings",
    "maintenance_groups",
    "maintenance_group_items",
    "maintenance_board_options",
    "maintenance_board_columns",
    "maintenance_board_cells",
  ];
  for (const table of tables) {
    assert.match(
      migration,
      new RegExp("UPDATE `" + table + "` SET `organisation_id`"),
      `${table} must be backfilled`,
    );
  }
  assert.match(migration, /CREATE TABLE `memberships`/);
  assert.match(migration, /CREATE TABLE `option_sets`/);
  assert.match(migration, /CREATE TABLE `option_values`/);
});
