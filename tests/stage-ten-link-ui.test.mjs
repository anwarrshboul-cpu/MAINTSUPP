import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

test("the contractor link panel is reachable from a job", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /import ContractorLinkPanel from "\.\/contractor-link-panel"/);
  assert.match(portal, /<ContractorLinkPanel/);
  assert.match(portal, /activeTab === "link"/, "the drawer needs a tab for it");

  const types = await read("app/lib/types.ts");
  assert.match(types, /RequestDrawerTab[\s\S]{0,200}"link"/);
});

test("the generated link is presented as shown-once", async () => {
  const panel = await read("app/(app)/portal/contractor-link-panel.tsx");
  assert.match(panel, /shown once/i);
  assert.match(
    panel,
    /cannot be retrieved later/i,
    "the coordinator must know the URL is not recoverable",
  );
  // It must not be persisted anywhere client-side.
  assert.doesNotMatch(panel, /localStorage|sessionStorage/);
});

test("WhatsApp share is a plain link, not an integration", async () => {
  const panel = await read("app/(app)/portal/contractor-link-panel.tsx");
  assert.match(panel, /https:\/\/wa\.me\/\?text=/);
  assert.match(panel, /encodeURIComponent\(shareText\)/);
  // Email fallback for contractors who do not use WhatsApp.
  assert.match(panel, /mailto:/);
});

test("pending evidence can be accepted or rejected from the panel", async () => {
  const panel = await read("app/(app)/portal/contractor-link-panel.tsx");
  assert.match(panel, /review\(item\.id, "accept"\)/);
  assert.match(panel, /review\(item\.id, "reject"\)/);
  assert.match(panel, /Evidence waiting for review/);
});

test("a live link can be revoked, an expired one cannot", async () => {
  const panel = await read("app/(app)/portal/contractor-link-panel.tsx");
  assert.match(
    panel,
    /link\.state !== "revoked" && link\.state !== "expired"/,
    "revoking an already-dead link is meaningless and should not be offered",
  );
});

test("link state is surfaced so an ignored link is visible", async () => {
  const panel = await read("app/(app)/portal/contractor-link-panel.tsx");
  assert.match(panel, /sent: "Sent, not opened"/);
  for (const state of ["opened", "expired", "revoked"]) {
    assert.match(panel, new RegExp(`${state}: "`), `${state} must be labelled`);
  }
});

test("the coordinator is told when a contractor acts", async () => {
  const route = await read("app/api/job-link/[token]/route.ts");
  // The event name is built as `contractor.${kind}`, so assert the call sites
  // rather than a literal that never appears in the source.
  assert.match(route, /event: "contractor\.opened"/, "first open must alert");
  for (const kind of ["completion", "blocked"]) {
    assert.match(
      route,
      new RegExp(`notifyCoordinator\\(db, scope, "${kind}"`),
      `${kind} must alert the coordinator`,
    );
  }
  assert.match(route, /event: `contractor\.\$\{kind\}`/);
  const templates = await read("app/lib/notifications.ts");
  assert.match(templates, /export function contractorEventTemplate/);
});

test("a notification failure never breaks the contractor's submission", async () => {
  const route = await read("app/api/job-link/[token]/route.ts");
  const helper = route.slice(route.indexOf("async function notifyCoordinator"));
  assert.match(helper.slice(0, 2200), /try \{/);
  assert.match(helper.slice(0, 2200), /\} catch \{/);
  assert.match(
    route,
    /must not make him think it\s*\n?\s*\*?\s*did not go through/,
    "the reasoning must be recorded in the code",
  );
});

test("the panel meets the mobile standard", async () => {
  const css = await read("app/brand-overrides.css");
  const section = css.slice(css.indexOf("Contractor link panel (Stage 10"));
  assert.match(section, /font-size: 16px/);
  assert.match(section, /min-height: 44px/);
  assert.match(section, /flex-wrap: wrap/, "the action row must wrap on a phone");
});

test("no fixed tenant identifier in the stage 10 files", async () => {
  for (const file of [
    "app/(app)/portal/contractor-link-panel.tsx",
    "app/api/job-link/[token]/route.ts",
  ]) {
    const source = await read(file);
    assert.doesNotMatch(source, /"sunnamusk-uk"/);
    assert.doesNotMatch(source, /\bCLIENT_ID\b\s*=/);
  }
});
