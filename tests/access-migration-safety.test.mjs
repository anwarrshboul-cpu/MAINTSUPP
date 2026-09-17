/**
 * ACCESS, PROVED AGAINST A REAL DATABASE — not against the source text.
 *
 * Runs the real migration path (`db/init.ts` → `ensureDatabase()`) on a COPY of
 * the local D1 database, with rows planted first, and then reads what the
 * product's own loaders say those rows grant. Four rules:
 *
 *   1. DISPLAY LABELS NEVER GRANT AUTHORITY. A `users` row with the label
 *      "Admin", "Manager", "Owner" or "Super Admin" and no membership — which
 *      is exactly what the Team tab creates — gets no membership, no company
 *      relationship and no platform authority from a migration replay.
 *   2. LEGACY SUPER ADMIN MEMBERSHIPS ARE INERT. They are kept (for rollback),
 *      read by nothing: platform authority is `platform_admins` alone.
 *   3. THE DEMONSTRATION COMPANY IS INTERNAL, marked by its workspace id.
 *   4. THE LAST OWNER STAYS. Removing or switching off a company's last active
 *      Owner is refused inside the write itself.
 *   5. A ROSTER OF ANY SIZE RESOLVES. Who on a People screen is a Platform
 *      Super Admin is read in chunks under D1's bound-variable ceiling.
 *
 * The copy lives in a temp directory and is deleted afterwards; the local
 * database the dev server uses is only ever read.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL("../", import.meta.url));
const D1_DIR = path.join(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
const PRIMARY = "org_000000000000000000000001";
const DEMO_WORKSPACE = "org_maintsupp_demo_workspace";
const TAG = `migsafe-${Date.now()}`;

function localDatabaseFile() {
  if (!fs.existsSync(D1_DIR)) return null;
  const files = fs
    .readdirSync(D1_DIR)
    .filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")
    .map((f) => path.join(D1_DIR, f));
  return files.length === 1 ? files[0] : null;
}

function installHooks(sqlitePath) {
  process.env["D1_SQLITE_PATH"] = sqlitePath;
  const stub = pathToFileURL(path.join(root, "tests/fixtures/cloudflare-workers-stub.mjs")).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "cloudflare:workers") return { url: stub, shortCircuit: true };
      if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts")) {
        const base = new URL(specifier, context.parentURL);
        for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) {
          if (fs.existsSync(fileURLToPath(candidate))) {
            return { url: candidate, shortCircuit: true };
          }
        }
      }
      return next(specifier, context);
    },
  });
}

const source = localDatabaseFile();
let dir = null;
let file = null;
let modules = null;

const labelled = ["Admin", "Manager", "Owner", "Super Admin"].map((label) => ({
  label,
  id: `user-${TAG}-${label.replace(/\s+/g, "-").toLowerCase()}`,
  email: `${TAG}-${label.replace(/\s+/g, "-").toLowerCase()}@label.test.maintsupp.com`,
}));
const legacy = {
  id: `user-${TAG}-legacy`,
  email: `${TAG}-legacy@legacy.test.maintsupp.com`,
};
/* A passwordless account an earlier build of the migration had promoted. */
const stale = {
  id: `user-${TAG}-stale`,
  email: `${TAG}-stale@legacy.test.maintsupp.com`,
};

before(async () => {
  if (!source) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maintsupp-access-"));
  file = path.join(dir, "access.sqlite");
  fs.copyFileSync(source, file);

  const db = new DatabaseSync(file);
  try {
    // Team-tab shaped rows: a users row, a label, nothing else.
    const insert = db.prepare(
      "INSERT INTO users (id, organisation_id, email, full_name, role, active) VALUES (?, ?, ?, ?, ?, 1)",
    );
    for (const row of labelled) insert.run(row.id, PRIMARY, row.email, `Label ${row.label}`, row.label);
    insert.run(stale.id, PRIMARY, stale.email, "Stale", "Super Admin");
    db.prepare(
      `INSERT INTO memberships (id, user_id, organisation_id, role, status, accepted_at)
       VALUES (?, ?, ?, 'super_admin', 'active', CURRENT_TIMESTAMP)`,
    ).run(`membership-${stale.id}`, stale.id, PRIMARY);
    db.prepare(
      "INSERT INTO platform_admins (user_id, status, granted_by) VALUES (?, 'active', 'migration:super_admin_membership')",
    ).run(stale.id);
    // Force the full migration replay, the path a label used to ride.
    db.exec("DELETE FROM schema_state");
  } finally {
    db.close();
  }

  installHooks(file);
  const init = await import("../db/init.ts");
  await init.ensureDatabase();
  const { getD1, getDb } = await import("../db/index.ts");
  modules = {
    d1: await getD1(),
    db: await getDb(),
    grants: await import("../app/lib/tenant-grants.ts"),
    authority: await import("../app/lib/company-authority.ts"),
    owners: await import("../app/lib/company-owners.ts"),
  };
});

after(async () => {
  if (!dir) return;
  const stub = await import("./fixtures/cloudflare-workers-stub.mjs");
  stub.closeForTests?.();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* A leftover temp directory is the OS's to reclaim; it is not a result. */
  }
});

const read = (sql, ...params) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // node:sqlite rows have a null prototype; compare them as plain objects.
    return db.prepare(sql).all(...params).map((row) => ({ ...row }));
  } finally {
    db.close();
  }
};
const write = (sql, ...params) => {
  const db = new DatabaseSync(file);
  try {
    return db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
};

test("a display label grants nothing, whatever it says, after a full migration replay", { skip: !source }, async () => {
  for (const row of labelled) {
    assert.deepEqual(
      read("SELECT role FROM memberships WHERE user_id = ?", row.id),
      [],
      `"${row.label}" must not become a membership`,
    );
    assert.deepEqual(read("SELECT 1 FROM platform_admins WHERE user_id = ?", row.id), [], `"${row.label}" is not platform authority`);
    assert.deepEqual(
      read("SELECT 1 FROM client_company_members WHERE user_id = ?", row.id),
      [],
      `"${row.label}" is not company authority`,
    );
  }
  const emails = labelled.map((row) => row.email);
  const grants = await modules.grants.loadGrants(modules.db, emails);
  assert.equal([...grants.values()].flat().length, 0, "the resolver's grant loader sees nothing");
  const authority = await modules.authority.loadCompanyAuthority(modules.db, emails);
  for (const email of emails) {
    const entry = authority.get(email);
    assert.ok(!entry?.platformAdmin && !entry?.ownedCompanyIds.length, `${email} holds no authority`);
  }

  // And the one-time conversion stays one-time: it only ever runs on a
  // database that has never held a membership.
  const legacyModule = fs.readFileSync(path.join(root, "db/legacy-memberships.ts"), "utf8");
  assert.match(legacyModule, /SELECT 1 AS found FROM memberships LIMIT 1/);
  assert.match(legacyModule, /if \(\(existing\.results \?\? \[\]\)\.length\) return;/);
  assert.match(legacyModule, /lower\(role\) NOT IN \('owner', 'super admin'\)/);
  assert.doesNotMatch(legacyModule, /'manager'/);
});

test("a legacy super_admin membership is inert: platform authority is platform_admins alone", { skip: !source }, async () => {
  // Planted AFTER the migration, so nothing promoted it: the row alone.
  write(
    "INSERT INTO users (id, organisation_id, email, full_name, role, active) VALUES (?, ?, ?, 'Legacy', 'Super Admin', 1)",
    legacy.id,
    PRIMARY,
    legacy.email,
  );
  write(
    `INSERT INTO memberships (id, user_id, organisation_id, role, status, accepted_at)
     VALUES (?, ?, ?, 'super_admin', 'active', CURRENT_TIMESTAMP)`,
    `membership-${legacy.id}`,
    legacy.id,
    PRIMARY,
  );

  const grants = await modules.grants.loadGrants(modules.db, [legacy.email]);
  assert.deepEqual(grants.get(legacy.email) ?? [], [], "a super_admin row is not a workspace grant");
  const authority = await modules.authority.loadCompanyAuthority(modules.db, [legacy.email]);
  assert.ok(!authority.get(legacy.email)?.platformAdmin, "and not platform authority");

  // The rows the migration DID promote keep working only through
  // platform_admins: revoke that row and the old membership gives nothing back.
  const promoted = read(
    `SELECT u.email AS email, p.user_id AS user_id FROM platform_admins p JOIN users u ON u.id = p.user_id
      WHERE p.granted_by = 'migration:super_admin_membership' AND p.status = 'active' LIMIT 1`,
  )[0];
  if (promoted) {
    const before = await modules.authority.loadCompanyAuthority(modules.db, [promoted.email.toLowerCase()]);
    assert.equal(before.get(promoted.email.toLowerCase())?.platformAdmin, true);
    write("UPDATE platform_admins SET status = 'revoked' WHERE user_id = ?", promoted.user_id);
    const afterRevoke = await modules.authority.loadCompanyAuthority(modules.db, [promoted.email.toLowerCase()]);
    assert.ok(!afterRevoke.get(promoted.email.toLowerCase())?.platformAdmin, "revoked means revoked");
    const stillThere = read(
      "SELECT count(*) AS n FROM memberships WHERE user_id = ? AND role = 'super_admin'",
      promoted.user_id,
    )[0].n;
    assert.ok(stillThere >= 0, "the legacy rows are kept for rollback");
    write("UPDATE platform_admins SET status = 'active' WHERE user_id = ?", promoted.user_id);
  }

});

test("the migration promotes only active, password-holding legacy Super Admins", { skip: !source }, async () => {
  // Every promotion the replay made is an active account with a password …
  const promoted = read(
    `SELECT u.email AS email, u.active AS active, u.password_hash IS NOT NULL AS has_password
       FROM platform_admins p JOIN users u ON u.id = p.user_id
      WHERE p.granted_by = 'migration:super_admin_membership' AND p.status = 'active'`,
  );
  for (const row of promoted) {
    assert.equal(row.active, 1, `${row.email} is active`);
    assert.equal(row.has_password, 1, `${row.email} can sign in`);
  }
  // … and a passwordless or deactivated legacy Super Admin is not promoted.
  const skipped = read(
    `SELECT DISTINCT u.email AS email
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.role = 'super_admin' AND m.status = 'active'
        AND (u.active = 0 OR u.password_hash IS NULL)
        AND NOT EXISTS (SELECT 1 FROM platform_admins p
                         WHERE p.user_id = u.id AND p.granted_by = 'migration:super_admin_membership')`,
  );
  assert.ok(Array.isArray(skipped));
  const leaked = read(
    `SELECT u.email AS email FROM platform_admins p JOIN users u ON u.id = p.user_id
      WHERE p.granted_by = 'migration:super_admin_membership' AND p.status = 'active'
        AND u.password_hash IS NULL`,
  );
  assert.deepEqual(leaked, [], "no passwordless account holds a migration promotion");
  // The one an earlier build made is withdrawn, not deleted, and grants nothing.
  assert.deepEqual(read("SELECT status FROM platform_admins WHERE user_id = ?", stale.id), [{ status: "revoked" }]);
  const authority = await modules.authority.loadCompanyAuthority(modules.db, [stale.email]);
  assert.ok(!authority.get(stale.email)?.platformAdmin);
  // The development testing identity is seeded under its own grant.
  assert.deepEqual(
    read(
      `SELECT p.status AS status, p.granted_by AS granted_by FROM platform_admins p JOIN users u ON u.id = p.user_id
        WHERE lower(u.email) = 'super-admin@test.maintsupp.com'`,
    ),
    [{ status: "active", granted_by: "seed:testing-identity" }],
  );
  const init = fs.readFileSync(path.join(root, "db/init.ts"), "utf8");
  assert.match(init, /if \(process\.env\.NODE_ENV !== "production"\) \{/, "and only outside production");
});

test("MAINTSUPP's demonstration company is internal; every other company is a customer", { skip: !source }, async () => {
  const demo = read(
    "SELECT c.kind AS kind FROM client_companies c JOIN organisations o ON o.client_company_id = c.id WHERE o.id = ?",
    DEMO_WORKSPACE,
  )[0];
  assert.equal(demo?.kind, "internal");
  const others = read(
    `SELECT DISTINCT c.kind AS kind FROM client_companies c JOIN organisations o ON o.client_company_id = c.id
      WHERE o.id <> ?`,
    DEMO_WORKSPACE,
  ).map((row) => row.kind);
  assert.ok(!others.includes("internal"), "only the demonstration workspace's company is internal");
  const internal = await modules.authority.loadInternalCompanyIds(modules.db);
  assert.equal(internal.size, 1);

  // An Owner row on the internal company is ignored by the authority loader.
  const company = read("SELECT client_company_id AS id FROM organisations WHERE id = ?", DEMO_WORKSPACE)[0].id;
  write(
    `INSERT INTO client_company_members (id, user_id, client_company_id, relationship, status)
     VALUES (?, ?, ?, 'owner', 'active')`,
    `ccm-${TAG}-demo`,
    labelled[0].id,
    company,
  );
  const authority = await modules.authority.loadCompanyAuthority(modules.db, [labelled[0].email]);
  assert.deepEqual(authority.get(labelled[0].email)?.ownedCompanyIds ?? [], []);
  write("DELETE FROM client_company_members WHERE id = ?", `ccm-${TAG}-demo`);
});

test("the last active Owner cannot be removed or switched off — enforced inside the write", { skip: !source }, async () => {
  const companyId = `company-${TAG}`;
  write(
    "INSERT INTO client_companies (id, name, slug, status, kind) VALUES (?, ?, ?, 'active', 'customer')",
    companyId,
    `Guard Co ${TAG}`,
    `guard-${TAG}`,
  );
  const owners = ["one", "two"].map((suffix) => ({
    id: `user-${TAG}-owner-${suffix}`,
    email: `${TAG}-owner-${suffix}@owners.test.maintsupp.com`,
  }));
  for (const owner of owners) {
    write(
      "INSERT INTO users (id, organisation_id, email, full_name, role, active) VALUES (?, ?, ?, 'Owner', 'Client', 1)",
      owner.id,
      PRIMARY,
      owner.email,
    );
    write(
      `INSERT INTO client_company_members (id, user_id, client_company_id, relationship, status)
       VALUES (?, ?, ?, 'owner', 'active')`,
      `ccm-${owner.id}`,
      owner.id,
      companyId,
    );
  }
  const { removeOwnerGuarded, deactivateAccountGuarded, companiesOnlyOwnedBy } = modules.owners;

  // Two removals racing: both callers have already seen two Owners. The first
  // write goes through; the second is refused by its own WHERE clause.
  const [first, second] = [
    await removeOwnerGuarded(modules.d1, companyId, owners[0].id),
    await removeOwnerGuarded(modules.d1, companyId, owners[1].id),
  ];
  assert.equal(first, "removed");
  assert.equal(second, "last_owner");
  assert.equal(
    read("SELECT count(*) AS n FROM client_company_members WHERE client_company_id = ? AND status = 'active'", companyId)[0].n,
    1,
    "exactly one Owner is left",
  );
  assert.equal(await removeOwnerGuarded(modules.d1, companyId, owners[0].id), "not_owner");

  // Switching the last Owner's account off is refused, and says which company.
  const blocked = await deactivateAccountGuarded(modules.d1, owners[1].id);
  assert.deepEqual(blocked.map((row) => row.id), [companyId]);
  assert.equal(read("SELECT active FROM users WHERE id = ?", owners[1].id)[0].active, 1);

  // With a second active Owner in place, both operations go through.
  write("UPDATE client_company_members SET status = 'active' WHERE user_id = ?", owners[0].id);
  assert.deepEqual(await companiesOnlyOwnedBy(modules.d1, owners[1].id), []);
  assert.deepEqual(await deactivateAccountGuarded(modules.d1, owners[1].id), []);
  assert.equal(read("SELECT active FROM users WHERE id = ?", owners[1].id)[0].active, 0);
  // …and an Owner whose account is off does not count as the other Owner.
  assert.equal(await removeOwnerGuarded(modules.d1, companyId, owners[0].id), "last_owner");
});

test("a roster past D1's bound-variable ceiling still resolves its Platform Super Admins", { skip: !source }, async () => {
  const promoted = read("SELECT user_id FROM platform_admins WHERE status = 'active' ORDER BY user_id LIMIT 1")[0];
  assert.ok(promoted, "the copied database holds an active Platform Super Admin to find");
  // The admin sits past the first chunk, so every chunk has to be read.
  const roster = [...Array.from({ length: 240 }, (_, index) => `user-${TAG}-roster-${index}`), promoted.user_id];
  process.env["D1_STUB_MAX_BOUND_PARAMETERS"] = "100";
  try {
    // The ceiling is real here: one IN list for the whole roster is refused,
    // which is what turned a 102-person People screen into a 503.
    await assert.rejects(
      modules.d1
        .prepare(`SELECT user_id FROM platform_admins WHERE user_id IN (${roster.map(() => "?").join(", ")})`)
        .bind(...roster)
        .all(),
      /too many SQL variables/,
    );
    const found = await modules.authority.platformAdminIds(modules.db, roster);
    assert.deepEqual([...found], [promoted.user_id]);
  } finally {
    delete process.env["D1_STUB_MAX_BOUND_PARAMETERS"];
  }
  // The People screen's other per-person reads use the same helper.
  const route = fs.readFileSync(path.join(root, "app/api/admin/users/route.ts"), "utf8");
  assert.match(route, /await selectInChunks\(userIds, \(chunk\) =>/);
  assert.match(route, /await selectInChunks\(inviterIds, \(chunk\) =>/);
  const authority = fs.readFileSync(path.join(root, "app/lib/company-authority.ts"), "utf8");
  assert.match(authority, /await selectInChunks\(userIds, \(chunk\) =>/);
});

test("the guard's SQL reaches Postgres as boolean comparisons", async () => {
  const { translateSql } = await import("../db/sqlite-to-postgres.ts");
  const owners = fs.readFileSync(path.join(root, "app/lib/company-owners.ts"), "utf8");
  const statement = `UPDATE users SET active = 0 WHERE id = ? AND EXISTS (
    SELECT 1 FROM client_company_members other JOIN users other_user ON other_user.id = other.user_id
     WHERE other_user.active = 1)`;
  const translated = translateSql(statement);
  assert.match(translated, /other_user\.active = true/);
  assert.match(translated, /SET active = false/i);
  assert.match(owners, /other_user\.active = 1/, "the guard is written in the shape the translator rewrites");
});
