/**
 * The status → stage mapping exists in three places. This proves they agree.
 *
 *   1. Postgres  — `job_stage_for(job_status)`, which GENERATES `jobs.stage`.
 *                  This is the authority: it is what the data actually says.
 *   2. `apps/web/lib/job-stages.ts` — so the board can group a status picker
 *                  and lay out its columns without a round trip.
 *   3. `app/lib/job-stages.ts` — the legacy app, covered by its own test.
 *
 * A copy of a rule is only safe if something fails when the copies diverge.
 * Without this, adding a status in a migration and forgetting the UI silently
 * drops it out of every column — the job exists, the board does not show it,
 * and every count still agrees with every other count. That is the worst kind
 * of wrong, and this product has already shipped it once.
 *
 * Read as text rather than imported: `apps/web` is a Next.js app whose modules
 * expect its own bundler and path aliases, and importing across that boundary
 * to check four constants would couple the API's test run to the web build.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestDb, type Db } from "../../../packages/db/src/client.ts";

let db: Db;

before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.close();
});

const WEB_MAPPING = new URL(
  "../../web/lib/job-stages.ts",
  import.meta.url,
);

/** Pulls `Stage: ["A", "B"]` entries out of the STAGE_STATUSES literal. */
function webMapping(): Map<string, string[]> {
  const source = readFileSync(WEB_MAPPING, "utf8");
  const start = source.indexOf("STAGE_STATUSES");
  assert.notEqual(start, -1, "apps/web/lib/job-stages.ts has no STAGE_STATUSES");

  // The object literal ends at the first line that is exactly "};".
  const end = source.indexOf("\n};", start);
  const block = source.slice(start, end);

  const mapping = new Map<string, string[]>();
  // Each entry is `Name: [ … ]` or `"Name": [ … ]`.
  const entry = /(?:"([^"]+)"|([A-Za-z]+))\s*:\s*\[([^\]]*)\]/g;
  for (const match of block.matchAll(entry)) {
    const stage = match[1] ?? match[2];
    const statuses = [...match[3].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    mapping.set(stage, statuses);
  }
  return mapping;
}

describe("the web board's stage mapping matches the database", () => {
  test("every status Postgres knows is mapped by the web app, to the same stage", async () => {
    const truth = await db.query<{ status: string; stage: string }>(
      `select s::text as status, job_stage_for(s)::text as stage
         from unnest(enum_range(null::job_status)) s`,
    );
    const web = webMapping();

    const webStageOf = new Map<string, string>();
    for (const [stage, statuses] of web) {
      for (const status of statuses) webStageOf.set(status, stage);
    }

    const wrong: string[] = [];
    for (const row of truth) {
      const found = webStageOf.get(row.status);
      if (found === undefined) {
        wrong.push(`"${row.status}" is in the database but in no web stage`);
      } else if (found !== row.stage) {
        wrong.push(`"${row.status}": database says ${row.stage}, web says ${found}`);
      }
    }
    assert.deepEqual(wrong, [], `\n  ${wrong.join("\n  ")}\n`);
    assert.equal(truth.length, 23, "the board has 23 status labels");
    assert.equal(webStageOf.size, 23, "the web app maps a different number");
  });

  test("the web app invents no status the database does not have", async () => {
    const known = new Set(
      (
        await db.query<{ status: string }>(
          "select s::text as status from unnest(enum_range(null::job_status)) s",
        )
      ).map((row) => row.status),
    );

    const invented: string[] = [];
    for (const [stage, statuses] of webMapping()) {
      for (const status of statuses) {
        // A status the enum does not have can never appear on a job, so a
        // column keyed on it is dead UI that looks like a real, empty queue.
        if (!known.has(status)) invented.push(`${stage}: "${status}"`);
      }
    }
    assert.deepEqual(invented, [], `\n  ${invented.join("\n  ")}\n`);
  });

  test("the seven stage names match the database enum exactly", async () => {
    const dbStages = (
      await db.query<{ stage: string }>(
        "select s::text as stage from unnest(enum_range(null::job_stage)) s",
      )
    ).map((row) => row.stage);

    assert.deepEqual(
      [...webMapping().keys()].sort(),
      [...dbStages].sort(),
      "the web app's stage names differ from the job_stage enum",
    );
  });
});
