/**
 * The financial-integrity controls, pinned where an independent review broke
 * them.
 *
 * Every case below is a defect that was PROVEN against a running server, not a
 * theoretical one, and each was proven again to be fixed. They are gathered
 * here rather than scattered because they share a shape: each was a control
 * that looked present — a status ladder, a re-derivation, an `overpaidPence`
 * field, an org-scoped `where` — while the thing it was supposed to prevent
 * went straight past it.
 *
 * These are source pins. The behaviour was verified live; what this file
 * protects is the code that produced it, so a later refactor cannot quietly
 * undo any of it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

test("finalising an invoice does not approve it", async () => {
  /*
   * §13's approval bands, the approver count, maker/checker and client
   * sign-off are all enforced in ONE place: the `approve` action, through
   * `canApprove`. `finalise` used to target `approved` directly, so none of
   * them was on its path.
   *
   * Proven before the fix, on a £1,200 payable in the two-approver band: a
   * single call took it `draft -> approved` with `approvals: []` and
   * `approvalProgress {required: 2, held: 0, satisfied: false}`, and it
   * appeared immediately as a payment-run candidate. One holder of
   * `settings.edit` — which the built-in `admin` role has — defeated the whole
   * ladder alone.
   *
   * Proven after: the same call returns `under_review`, `finalisedAt` is set,
   * and the progress still reads `required: 2, held: 0, satisfied: false`.
   */
  const source = await read("app/api/finance/invoices/[id]/actions/route.ts");
  assert.match(
    source,
    /finalise: \{ payable: "under_review", receivable: "issued" \}/,
    "finalise lands a payable at the review stage, never at approved",
  );
  assert.doesNotMatch(
    source,
    /finalise: \{ payable: "approved"/,
    "and never targets approved again",
  );
  assert.match(
    source,
    /const nextStatus = from === "draft" \? finaliseTarget : from;/,
    "and it cannot move an already-approved invoice backwards either",
  );
  /* The one route that may confer approval still runs the ladder. */
  assert.match(source, /await canApprove\(/, "approve still asks canApprove");
});

test("a payment cannot exceed what is outstanding, or settle the same invoice twice", async () => {
  /*
   * There was no check at all. Proven: a £10 invoice accepted a £100 payment
   * and recorded `overpaidPence: 9000`. That is not cosmetic — a negative
   * balance on a PAYABLE flips sign in `signedForCashPosition`, so one mistyped
   * payment turns money owed into money expected and §9's net cash position
   * reads the wrong way round.
   *
   * Proven after the fix, in this order against one £10 invoice: £100 refused
   * naming the £10 outstanding; exactly £10 accepted; a second £10 refused as a
   * repeat settlement.
   */
  const source = await read("app/lib/finance/repository.ts");
  assert.match(
    source,
    /const outstanding = await invoiceBalances\(db, organisationId, \[\.\.\.seen\]\);/,
    "the balance is read immediately before the insert, not trusted from the browser",
  );
  assert.match(source, /if \(balancePence <= 0\)/, "nothing already settled can be paid again");
  assert.match(source, /if \(row\.amountPence > balancePence\)/, "and nothing can be overpaid");

  /*
   * `overpaidPence` must SURVIVE. Refusing to create an overpayment is a
   * different thing from refusing to show one: a credit note raised against an
   * invoice that was already settled leaves exactly that shape honestly, and
   * `rules.ts` is right that hiding it would be worse.
   */
  const rules = await read("app/lib/finance/rules.ts");
  assert.match(rules, /overpaidPence: balancePence < 0 \? -balancePence : 0/);
});

test("a payment run owns its invoices, and no invoice is in two runs", async () => {
  /*
   * The export re-derived "every approved or scheduled payable with a balance"
   * instead of reading a membership. Proven: a run created for one £10 invoice
   * exported two rows totalling £1,210; a second run created for one £1 invoice
   * exported three, re-including both of the first run's. Upload both files as
   * the product instructs and two suppliers are paid twice.
   *
   * Proven after: run one exports exactly £10, run two exactly £20, and adding
   * an already-claimed invoice to a second run is refused by name.
   */
  const create = await read("app/api/finance/payment-runs/route.ts");
  assert.match(create, /isNull\(invoices\.paymentRunId\)/, "a claimed invoice is not a candidate");
  assert.match(create, /set\(\{ paymentRunId: id/, "creating a run claims its invoices");
  assert.match(
    create,
    /already in another payment run/,
    "and says so plainly rather than silently dropping the row",
  );

  const exportRoute = await read("app/api/finance/payment-runs/[id]/export/route.ts");
  assert.match(exportRoute, /eq\(invoices\.paymentRunId, run\.id\)/, "the export reads the claim");

  /* A claim with no release would strand invoices in a draft run for ever. */
  const cancel = await read("app/api/finance/payment-runs/[id]/route.ts");
  assert.match(cancel, /export async function DELETE/);
  assert.match(cancel, /paymentRunId: null/, "cancelling releases what the run held");
  assert.match(
    cancel,
    /run\.status !== "draft"/,
    "but an exported run cannot be cancelled into a second payment",
  );
});

test("every finance join carries the organisation", async () => {
  /*
   * `invoices.site_id` and `invoice_job_allocations.request_id` are accepted as
   * free text, and these joins resolved them against the whole table. Proven
   * twice: an org-1 admin's `/api/finance/unbilled` returned org 2's job title
   * and completion date, and their Xero export carried org 2's site name. The
   * ids are human-readable (`store-woodgreen`, `MN-1356`), so it needs one
   * guess rather than a scrape.
   *
   * There is no RLS behind this — `CLAUDE.md` says so — which makes the join
   * predicate the entire boundary rather than a second line of defence.
   */
  const source = await read("app/lib/finance/analytics.ts");

  const joins = [...source.matchAll(/\.(?:left|inner)Join\(\s*([A-Za-z]+),?/g)].map(
    (match) => match[1],
  );
  assert.ok(joins.length >= 6, `expected the analytics joins to still be here, found ${joins.length}`);

  /* Each of the four tables reachable by a foreign id must be scoped. Written
     as literal `includes` rather than built regexes: a regex assembled from a
     template is one lost backslash away from asserting nothing at all. */
  for (const table of ["sites", "contractors", "maintenanceRequests", "invoices"]) {
    assert.ok(
      source.includes(`eq(${table}.organisationId, organisationId)`),
      `${table} is joined with an organisation predicate`,
    );
  }

  /* And no join may be left keyed on id alone. */
  for (const unscoped of [
    ".leftJoin(sites, eq(sites.id,",
    ".leftJoin(contractors, eq(contractors.id,",
    ".innerJoin(invoices, eq(invoices.id,",
    ".innerJoin(maintenanceRequests, eq(maintenanceRequests.id,",
  ]) {
    assert.ok(!source.includes(unscoped), `no id-only join remains: ${unscoped}`);
  }

  /* Including inside the correlated NOT EXISTS, where only `billed` was scoped. */
  assert.ok(
    source.includes("and sale.organisation_id = ${organisationId}"),
    "the correlated sale alias is scoped too, not only `billed`",
  );
});

test("a site-restricted membership cannot read outside its stores", async () => {
  /*
   * `memberships.site_scope` confines a member to named stores. The board has
   * always honoured it; no route under `/api/dashboard` ever did — not the ones
   * this release adds and not the ones that predate it. That leaked totals
   * before, and `/api/dashboard/records` is new and returns ROWS (reference,
   * title, site, status, cost, contractor, up to 200), which turns a wrong
   * subtotal into a list of jobs at stores the reader cannot open.
   *
   * All 22 memberships on Staging carry a null `site_scope` today, so this
   * changes nobody's figures — it is the case nobody has hit yet that matters.
   *
   * Exercised through the real module rather than a re-implementation, because
   * the failure mode here is subtle: an empty site list means "no filter", i.e.
   * EVERYTHING, so the obvious intersection would open the whole estate to
   * exactly the person being confined.
   */
  const ts = (await import("typescript")).default;
  const source = await read("app/lib/dashboard-route.ts");
  /* The helper is pure; strip the module's imports so it can be evaluated
     alone, the same trick the analytics suite uses. */
  const isolated = source
    .split("\n")
    .filter((line) => !/^import |^\} from |^  [a-zA-Z]+,$|^  type /.test(line))
    .join("\n");
  const start = isolated.indexOf("const FORBIDDEN_SITE");
  const end = isolated.indexOf("export async function dashboardScope");
  const { confineToSiteScope } = await import(
    `data:text/javascript,${encodeURIComponent(
      ts.transpileModule(isolated.slice(start, end), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    )}`
  );

  const base = { sites: [], priorities: [], families: [] };

  /* No restriction: untouched, filter and all. */
  assert.deepEqual(confineToSiteScope({ ...base, sites: ["a"] }, null).sites, ["a"]);

  /* Restricted, asking for nothing: confined to the allowed stores. */
  assert.deepEqual(confineToSiteScope(base, ["a", "b"]).sites, ["a", "b"]);

  /* Restricted, asking for one they hold: just that one. */
  assert.deepEqual(confineToSiteScope({ ...base, sites: ["a"] }, ["a", "b"]).sites, ["a"]);

  /* Restricted, asking for a mix: only the permitted half survives. */
  assert.deepEqual(confineToSiteScope({ ...base, sites: ["a", "z"] }, ["a", "b"]).sites, ["a"]);

  /*
   * THE ONE THAT MATTERS. Asking only for a store outside the scope must return
   * nothing — never an empty list, which downstream reads as "no filter".
   */
  const denied = confineToSiteScope({ ...base, sites: ["z"] }, ["a", "b"]).sites;
  assert.equal(denied.length, 1, "not an empty list");
  assert.equal(denied[0], "__site_outside_scope__", "a sentinel no row can carry");
});
