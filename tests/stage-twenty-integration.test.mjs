import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * The seams between the five Stage 20 workstreams.
 *
 * Each was built behind its own file boundary, so the places they meet are the
 * places nothing was watching. These lock the joins.
 */

test("every administration section is routable, not just rendered", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const page = await read("app/(app)/dashboard/[[...section]]/page.tsx");

  for (const section of ["admin-users", "admin-roles", "admin-clients"]) {
    assert.ok(portal.includes(`"${section}"`), `${section} must be a Section`);
    assert.ok(page.includes(`"${section}"`), `${section} must be reachable by URL`);
  }

  // The nested paths are the ones that silently resolved to the wrong screen
  // while the route keyed off the first segment alone.
  assert.match(page, /"admin\/roles": "admin-roles"/);
  assert.match(page, /"admin\/clients": "admin-clients"/);
  assert.match(
    page,
    /section\?\.join\("\/"\)/,
    "nested admin paths need every segment, not just the first",
  );
});

test("a signed-in user is not offered the testing role switcher", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");

  // `resolveTenantAccess` refuses to let the switcher widen a real session's
  // reach, so showing it to a signed-in user offers a control that does
  // nothing — they pick "Client", nothing changes, and the app looks broken.
  assert.match(
    portal,
    /runtimeContext\?\.testingMode === false \? \(/,
    "the switcher must be conditional on there being no session",
  );
  assert.match(portal, /className="sidebar-profile__role"/);

  // And the flag it keys off must be real rather than hardcoded, or the
  // condition above can never fire.
  const context = await read("app/api/context/route.ts");
  assert.match(context, /testingMode: !context\.authenticated/);
  assert.match(context, /authenticationEnabled: context\.authenticated/);
  assert.ok(
    !/authenticationEnabled: false/.test(context),
    "authenticationEnabled must reflect the session, not a constant",
  );
});

test("the dashboard greets whoever actually signed in", async () => {
  const page = await read("app/(app)/dashboard/[[...section]]/page.tsx");

  assert.match(page, /getSession\(/);
  // The preview identity has to survive for an unauthenticated browser, which
  // is still how the dashboard is demoed.
  assert.match(page, /\|\| "Preview User"/);
  assert.ok(
    !/userName="Preview User"/.test(page),
    "the name must come from the session when there is one",
  );
});

test("the sidebar's built-in order is not written twice without a check", async () => {
  // The client list and the server list are separate files by necessity — the
  // API answers without a browser. Adding a section to one and not the other is
  // the obvious mistake, and it was made once already.
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const layout = await read("app/api/navigation/layout.ts");

  for (const section of ["admin-users", "admin-roles", "admin-clients"]) {
    assert.ok(
      portal.includes(`"${section}"`) && layout.includes(`"${section}"`),
      `${section} must be in both the browser's order and the server's copy`,
    );
  }
});

test("the destructive and bulk-write paths are audited", async () => {
  const board = await read("app/api/board/route.ts");
  const importer = await read("app/api/import/route.ts");

  // The rows, their cells, their attachments and their activity_log history are
  // all gone by this point — the audit row is the only surviving record.
  assert.match(board, /action: "board\.items_deleted"/);
  // The import list is matched loosely on purpose: the board route now pulls
  // `changeDetail` alongside these two for the structural-change events added
  // in Batch 1A, and the property being pinned is that the route records
  // through the shared module at all — not the exact shape of one line.
  assert.match(board, /import \{[^}]*\brecordAudit\b[^}]*\} from "\.\.\/\.\.\/lib\/audit"/);
  assert.match(board, /import \{[^}]*\bauditActor\b[^}]*\} from "\.\.\/\.\.\/lib\/audit"/);

  assert.match(importer, /action: "data\.imported"/);
  assert.match(
    importer,
    /identity: identityRisk\(plan\)/,
    "an import's collapse risk belongs in the record of what it did",
  );
});

test("sign-in events are recorded, and never carry a secret", async () => {
  const login = await read("app/api/auth/login/route.ts");
  const invitations = await read("app/api/auth/invitations/route.ts");

  assert.match(login, /action: "session\.sign_in_failed"/);
  assert.match(login, /action: "session\.signed_in"/);
  // A failed sign-in has no workspace yet; dropping it for that reason would
  // lose exactly the events worth keeping.
  assert.match(login, /organisationId: null,/);

  // Neither the password nor the invitation token may reach the log. An audit
  // anyone with read access could mine for live invite links hands out access.
  // Non-greedy to the nearest close at ANY indentation: these calls sit at two
  // different depths, and anchoring on one of them ran the match past the end
  // of the block into unrelated code that legitimately mentions a token.
  const CALL = /await recordAudit\(\{[\s\S]*?\n\s*\}\);/g;
  const auditCalls = [
    ...login.matchAll(CALL),
    ...invitations.matchAll(CALL),
  ].map((match) => match[0]);
  assert.ok(auditCalls.length >= 3, "expected the sign-in and invite audit calls");
  for (const call of auditCalls) {
    for (const secret of ["password", "token", "inviteUrl", "tokenHash"]) {
      assert.ok(
        !call.includes(secret),
        `an audit call must not carry ${secret}:\n${call.slice(0, 200)}`,
      );
    }
  }
});
