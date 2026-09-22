/**
 * THE PORTAL-MODULE SWITCH, AT THE API (owner decision, 2026-09-22).
 *
 * §19 gave every workspace a switch per module and `tests/portal-module-registry.test.mjs`
 * proved the navigation and the four page entries obey it. The APIs did not: a
 * workspace with the Invoice Tracker switched off still answered
 * `/api/finance/*`, so the switch was a curtain in front of an open door — one
 * `fetch`, one bookmark, or a workspace section pointing at the same surface.
 *
 * This file is the map of what is gated and what deliberately is not, and it is
 * a map rather than a rule because NO RULE IS TRUE HERE. "Gate every route whose
 * path matches a module" would have shut the account area's recycle bin (the
 * only way to recover a deleted row), the job board's calendar view, and the
 * Overview's own figures. Reading the callers was the whole job; the reasons are
 * written beside each entry and at length in `app/lib/module-guard.ts`.
 *
 * So the test asks three things, and the third is the one that will catch the
 * next change:
 *
 *   1. every handler in the map asks, AFTER its capability guard — the switch is
 *      product configuration and must never answer in place of authorisation;
 *   2. the routes in `UNGATED` still do not ask, each for the reason recorded;
 *   3. no route asks that is not in the map, and no listed file grows a handler
 *      that does not ask. A new route into a gated module fails here rather than
 *      shipping a second open door, which is exactly how the first one happened.
 */

import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PORTAL_MODULE_KEYS, isDisableableModule, resolveModuleAccess } from "../app/lib/portal-modules.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/** The handlers a route file exports, in source order. */
function handlersOf(source) {
  return [...source.matchAll(/^export async function (GET|POST|PUT|PATCH|DELETE)\(/gm)].map(
    (match) => match[1],
  );
}

/** One handler's body: from its signature to the next export, or the end. */
function handlerBody(source, name) {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start > 0, `${name} is not exported`);
  const next = source.slice(start + 1).search(/^export (async function|const|function)/m);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

/**
 * FAMILY A — module-exclusive: only that module's own screens call it, so every
 * handler asks. Each key is the module the switch belongs to.
 */
const EXCLUSIVE = {
  "app/api/assets/route.ts": { key: "assets", handlers: ["GET", "POST", "PATCH", "DELETE"] },
  "app/api/assets/csv/route.ts": { key: "assets", handlers: ["GET"] },
  "app/api/teams/route.ts": { key: "team", handlers: ["GET", "POST", "PATCH"] },
  "app/api/teams/members/route.ts": { key: "team", handlers: ["POST", "DELETE"] },
  "app/api/audit/route.ts": { key: "audit", handlers: ["GET"] },
  "app/api/admin/users/route.ts": { key: "admin-users", handlers: ["GET", "POST", "DELETE", "PATCH"] },
  "app/api/admin/users/password-reset/route.ts": { key: "admin-users", handlers: ["POST"] },
  "app/api/admin/roles/route.ts": { key: "admin-roles", handlers: ["GET", "PUT"] },
  "app/api/admin/reconcile/route.ts": { key: "reconcile", handlers: ["GET"] },
};

/**
 * FAMILY B, at the operation — one module's own operation inside a family
 * several modules share. The family stays open; these do not.
 */
const OPERATIONS = {
  "app/api/reports/exports/route.ts": { key: "reports", handlers: ["GET", "POST"] },
  "app/api/reports/schedules/route.ts": { key: "reports", handlers: ["GET", "POST", "PATCH", "DELETE"] },
  "app/api/reports/schedules/run/route.ts": { key: "reports", handlers: ["POST"] },
  "app/api/planned-maintenance/generate/route.ts": { key: "calendar", handlers: ["POST"] },
  "app/api/compliance/backfill/route.ts": { key: "compliance", handlers: ["POST"] },
  "app/api/compliance/responsibilities/route.ts": { key: "compliance", handlers: ["GET", "POST"] },
  "app/api/compliance/template/route.ts": { key: "compliance", handlers: ["GET", "PUT"] },
  "app/api/notifications/compliance/route.ts": { key: "compliance", handlers: ["GET", "POST"] },
};

/**
 * FAMILY B, as a FILTER — one group inside an answer that is not the module's.
 * A search must still answer, so it drops the group instead of refusing, exactly
 * as it already does for a reader who may not see the ledger at all.
 */
const FILTERS = {
  "app/api/search/route.ts": { key: "invoice-tracker", helper: "moduleOff" },
};

/** The two shared doors every route of their module already passes through. */
const GUARDS = {
  "app/lib/finance/access.ts": "invoice-tracker",
  "app/lib/reporting/route-helpers.ts": "reports",
};

/**
 * NOT GATED, ON PURPOSE. The reason is the test: each of these would be a defect
 * if somebody "completed" the enforcement by adding it.
 */
const UNGATED = {
  "app/api/trash/route.ts":
    "the Recycle Bin module is a door, not a room: the account area draws the same panel over this API, and it is the only way back for a deleted row",
  "app/api/maintenance/calendar/route.ts":
    "the job board's calendar view reads the manual events too, not only Planned",
  "app/api/compliance/provider/route.ts":
    "the renewal contractor is edited from the shared data-manager record form as well",
  "app/api/compliance/metrics/route.ts": "the Overview reads it",
  "app/api/compliance/summary/route.ts": "the Overview reads it",
  "app/api/compliance/records/route.ts": "Store Documentation and the Overview read it",
  "app/api/reports/metrics/route.ts": "the Overview's figures as well as the Reports dashboard's",
  "app/api/board/route.ts": "the board is the shared foundation of most modules",
  "app/api/files/route.ts": "evidence belongs to jobs, sites, units and contractors alike",
  "app/api/sites/route.ts": "sites are read by every module",
  "app/api/workspace/route.ts": "one snapshot serves the whole portal",
  "app/api/cron/daily/route.ts":
    "a switch hides a screen; it must not silently stop a statutory planned visit being raised or a scheduled report going out",
  "app/api/cron/planned-maintenance/route.ts": "the same reason as the daily run",
  "app/api/portal-modules/route.ts": "this IS the switchboard — gating it would make a switch unswitchable",
  "app/api/admin/clients/route.ts":
    "clients.view_all is the Super Admin's alone and the Super Admin is exempt, so the check could never refuse",
  "app/api/admin/companies/route.ts": "the same reason, and an owner reaches it for their own company",
};

test("every module-exclusive handler asks whether the module is switched off", async () => {
  for (const [file, { key, handlers }] of Object.entries(EXCLUSIVE)) {
    const source = await read(file);
    assert.ok(PORTAL_MODULE_KEYS.includes(key), `${file} names a module that does not exist: ${key}`);
    assert.ok(isDisableableModule(key), `${file} names ${key}, which cannot be switched off at all`);
    assert.deepEqual(
      handlersOf(source),
      handlers,
      `${file} exports handlers this map does not list — decide whether the new one is gated and say so here`,
    );
    for (const handler of handlers) {
      const body = handlerBody(source, handler);
      assert.match(
        body,
        new RegExp(String.raw`moduleRefusal\([^)]*"${key}"\)`),
        `${file} ${handler} must ask about ${key}`,
      );
      /* AFTER the capability guard. A 403 about a switch in place of a 401 about
         a session, or of a 403 about authority, would tell an anonymous caller
         which modules a workspace runs. */
      assert.match(
        body,
        /(\.denied\) return|isRefusal\(context\)\) return context|await scopedDb\(request\))[\s\S]*?moduleRefusal/,
        `${file} ${handler} must ask AFTER its own guard, never before`,
      );
    }
  }
});

test("a module's own operation inside a shared family is gated, and only that operation", async () => {
  for (const [file, { key, handlers }] of Object.entries(OPERATIONS)) {
    const source = await read(file);
    assert.ok(isDisableableModule(key), `${file} names ${key}, which cannot be switched off`);
    assert.deepEqual(handlersOf(source), handlers, `${file}: an unlisted handler`);
    for (const handler of handlers) {
      assert.match(
        handlerBody(source, handler),
        new RegExp(String.raw`moduleRefusal\([^)]*"${key}"\)`),
        `${file} ${handler} must ask about ${key}`,
      );
    }
  }
});

test("the finance and report-document guards carry it for every route behind them", async () => {
  const finance = await read("app/lib/finance/access.ts");
  assert.match(finance, /moduleRefusal\(guard\.scope, "invoice-tracker"\)/);
  /* Last of the three checks in `guardFinance`: capability, then rank, then the
     switch — so the ledger never explains a switch to somebody who may not read
     it in the first place. */
  assert.ok(
    finance.indexOf("ROLE_RANK.admin") < finance.indexOf('moduleRefusal(guard.scope, "invoice-tracker")'),
    "the rank rule must be decided before the switch",
  );
  const reports = await read("app/lib/reporting/route-helpers.ts");
  assert.match(reports, /moduleRefusal\(guarded\.scope, "reports"\)/);
  assert.ok(
    reports.indexOf("everySiteRefusal") < reports.indexOf('moduleRefusal(guarded.scope, "reports")'),
    "the site-scope refusal must be decided before the switch",
  );
});

test("a cross-workspace list is judged workspace by workspace", async () => {
  /* `/api/audit` reads every workspace where the reader holds `audit.read`. The
     switch is per workspace, so one that has Audit switched off must drop out of
     that list — not merely be hidden when it happens to be the selected one. */
  const source = await read("app/api/audit/route.ts");
  assert.match(source, /if \(await moduleSwitchedOff\(scope\.db, id, "audit"\)\) continue;/);
  assert.match(source, /moduleRefusal\(scope, "audit"\)/);
});

test("a search filters the module's group out rather than refusing the search", async () => {
  const source = await read("app/api/search/route.ts");
  for (const [file, { key, helper }] of Object.entries(FILTERS)) {
    assert.equal(file, "app/api/search/route.ts");
    assert.match(source, new RegExp(String.raw`${helper}\(scope, "${key}"\)`));
  }
  /* Never a refusal: the jobs, sites, contractors, documents and people groups
     are the reader's whatever the Invoice Tracker's switch says. */
  assert.doesNotMatch(source, /moduleRefusal/);
  /* And the filter belongs to the finance groups only — it joins the one
     condition that already decides whether the ledger is answered at all. */
  const financeReader = source.slice(
    source.indexOf("const financeReader ="),
    source.indexOf("if (financeReader) {"),
  );
  assert.match(financeReader, /moduleOff\(scope, "invoice-tracker"\)/);
});

test("the routes left open are still open, each for its recorded reason", async () => {
  for (const [file, reason] of Object.entries(UNGATED)) {
    const source = await read(file);
    assert.doesNotMatch(
      source,
      /moduleRefusal|moduleSwitchedOff|moduleOff/,
      `${file} must NOT consult the switch: ${reason}`,
    );
  }
});

test("no route consults the switch without being on the map", async () => {
  const declared = new Set([
    ...Object.keys(EXCLUSIVE),
    ...Object.keys(OPERATIONS),
    ...Object.keys(FILTERS),
  ]);
  const walk = (dir) => {
    const out = [];
    for (const entry of readdirSync(path.join(root, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(path.join(root, rel)).isDirectory()) out.push(...walk(rel));
      else if (entry.endsWith(".ts")) out.push(rel);
    }
    return out;
  };
  const asking = [];
  for (const file of walk("app/api")) {
    if (/\bmoduleRefusal\(|\bmoduleSwitchedOff\(|\bmoduleOff\(/.test(await read(file))) asking.push(file);
  }
  assert.deepEqual(
    asking.filter((file) => !declared.has(file)),
    [],
    "a route consults the module switch without an entry above — add it, with which module and why",
  );
});

test("the helper checks the switch and nothing else", async () => {
  const guard = await read("app/lib/module-guard.ts");
  /* A module that cannot be switched off is never refused: Overview is where the
     portal lands and Settings is where the switches are. */
  assert.match(guard, /if \(!definition \|\| !definition\.disableable\) return (null|false);/);
  /* The Platform Super Admin is exempt, as from every ceiling — they set these
     switches, and they must be able to switch one back on for a workspace that
     cannot. */
  assert.match(guard, /if \(scope\.platformAdmin \|\| scope\.actor\.role === "super_admin"\) return false;/);
  /* ONE place decides the exemption: the 403 and the search filter ask the same
     function, so it cannot hold in one and not the other. */
  assert.match(guard, /if \(!\(await moduleOff\(scope, key\)\)\) return null;/);
  /* Fails OPEN on an unreadable registry, for the reason `page-guard.ts` gives:
     the shipped product is every module on, and a database hiccup must not lock
     every member out of every module. `readModuleOverrides` answers `{}`. */
  assert.match(guard, /readModuleOverrides\(db, orgId\)/);
  assert.match(guard, /return overrides\[key\] === false;/);
  /* 403, naming the module and the screen that switched it off, and a flag a
     client can branch on. */
  assert.match(guard, /moduleDisabled: true/);
  assert.match(guard, /\{ status: 403 \}/);
  assert.match(guard, /Settings → Portal modules/);
  /* The capability model is untouched: no capability, role or ceiling appears
     here. The switch is configuration; authorisation stays where it lives. */
  assert.doesNotMatch(guard.replace(/\/\*[\s\S]*?\*\//g, ""), /Capability|ROLE_CEILINGS|requireCapability|can\(/);
});

test("switched off means the same thing to the API as it does to the sidebar", () => {
  /* `resolveModuleAccess` decides `enabled` for the navigation and the page
     guard; the API helper re-reads the same row. The two must agree about what a
     row means, which is the one fact both sides encode:
     `overrides[key] !== false` is enabled. */
  for (const key of PORTAL_MODULE_KEYS) {
    const off = resolveModuleAccess(key, { [key]: false }, { "board.view": true }, "admin");
    assert.equal(
      off.enabled,
      !isDisableableModule(key),
      `${key}: a row saying false must disable exactly the modules that may be disabled`,
    );
    const on = resolveModuleAccess(key, {}, { "board.view": true }, "admin");
    assert.equal(on.enabled, true, `${key}: no row is the shipped state, which is on`);
  }
});
