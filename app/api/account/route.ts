/**
 * The signed-in person's own account — Stage 20, avatar menu.
 *
 * Reproduces what monday's avatar menu header and "My profile" screen read:
 * the person, the workspace they are looking at, and the workspace's plan.
 * monday shows a credits pill next to the workspace name; the MAINTSUPP
 * equivalent is `organisations.plan_tier`, so the pill is a plan tier and is
 * read from the row rather than assumed.
 *
 * Why raw SQL for the profile columns. `db/schema.ts` declares `users` with the
 * original eight columns; the Stage 20 additions (job_title, phone, timezone,
 * avatar_colour, theme_preference, working_status, password_updated_at,
 * last_login_at) are added by the PRAGMA-guarded migration in `db/init.ts` and
 * are not in the Drizzle model. That file is owned elsewhere, so this route
 * reads the columns it needs directly instead of editing the shared schema.
 */

import { and, count, eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { CANONICAL_REGISTER, registerScopeFilter } from "../../lib/register-scope";
import {
  maintenanceRequests,
  memberships,
  sites,
  units,
} from "../../../db/schema";
import { anonymousRefusal, scopedDb } from "../../lib/tenant-db";

/**
 * The presence values the working-status row may set.
 *
 * Named `..._VALUES` rather than `..._STATUSES` on purpose: the configurability
 * guard in `tests/stage-two-sites-units.test.mjs` forbids a `*STATUSES*`
 * constant, because a *board* status must be an `option_values` row an admin
 * can edit. This is not one of those — it is a person's presence, a fixed part
 * of the menu's behaviour like monday's own "Do not disturb", with no admin
 * screen behind it and nothing on a board reading it.
 */
export const WORKING_STATUS_VALUES = [
  "available",
  "do_not_disturb",
  "in_a_meeting",
  "working_from_home",
  "on_site",
  "out_of_office",
] as const;

export type WorkingStatus = (typeof WORKING_STATUS_VALUES)[number];

/**
 * The three themes the stylesheets implement, and the picker offers.
 *
 * This comment used to say dark was the only one and that the other two were
 * accepted so a picker "could become real without a migration". Both stopped
 * being true: `brand-overrides.css` carries a full `body[data-theme="light"]`
 * skin, and `theme.ts` resolves "system" through `prefers-color-scheme`. Dark
 * is the DEFAULT — what an absent preference paints — which is a different
 * statement from being the only implementation, and the difference is the whole
 * point of keeping all three selectable.
 *
 * The order is not arbitrary: dark first because it is the default.
 */
export const SUPPORTED_THEMES = ["dark", "light", "system"] as const;

/** Avatar colours offered on the profile screen — the app's own palette. */
export const AVATAR_COLOURS = [
  "#12b4a8",
  "#f08b23",
  "#da4646",
  "#5c82af",
  "#7d5ba6",
  "#3f9e5c",
] as const;

type UserRow = {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  job_title: string | null;
  phone: string | null;
  timezone: string | null;
  avatar_colour: string | null;
  theme_preference: string | null;
  working_status: string | null;
  password_updated_at: string | null;
  last_login_at: string | null;
  created_at: string | null;
};

const USER_COLUMNS = sql`id, email, full_name, role, job_title, phone, timezone, avatar_colour, theme_preference, working_status, password_updated_at, last_login_at, created_at`;

type Database = Awaited<ReturnType<typeof scopedDb>>["db"];

async function readUser(db: Database, email: string) {
  const rows = await db.all<UserRow>(
    sql`SELECT ${USER_COLUMNS} FROM users WHERE email = ${email} LIMIT 1`,
  );
  return rows[0] ?? null;
}

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** IANA zone names only — the profile screen writes this into date formatting. */
function validTimezone(value: string) {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function profilePayload(row: UserRow | null, email: string) {
  return {
    /** Null when the resolved identity has no `users` row yet — an honest gap. */
    exists: Boolean(row),
    id: row?.id ?? null,
    email: row?.email ?? email,
    fullName: row?.full_name ?? null,
    role: row?.role ?? null,
    jobTitle: row?.job_title ?? null,
    phone: row?.phone ?? null,
    timezone: row?.timezone ?? "Europe/London",
    avatarColour: row?.avatar_colour ?? null,
    themePreference: row?.theme_preference ?? "dark",
    workingStatus: row?.working_status ?? null,
    passwordUpdatedAt: row?.password_updated_at ?? null,
    lastLoginAt: row?.last_login_at ?? null,
    createdAt: row?.created_at ?? null,
  };
}

/**
 * What the workspace actually holds, for the Plan & billing screen.
 *
 * Real counts rather than invented seat/usage figures: there is no metering in
 * this product, so the only truthful thing a billing screen can show is the
 * size of what is stored.
 */
async function usage(db: Database, orgId: string) {
  const [jobRows, siteRows, unitRows, memberRows] = await Promise.all([
    db
      .select({ value: count() })
      .from(maintenanceRequests)
      // Stage 23 — the usage tile counts live jobs. A job in the recycle bin is
      // not one the workspace is using.
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          isNull(maintenanceRequests.deletedAt),
        ),
      ),
    /* The workspace's own site register. A site inside a custom Sites
       section is counted on that section, not on the workspace's usage tile. */
    db
      .select({ value: count() })
      .from(sites)
      .where(
        and(
          eq(sites.organisationId, orgId),
          registerScopeFilter(sites.boardId, CANONICAL_REGISTER),
        ),
      ),
    db.select({ value: count() }).from(units).where(eq(units.organisationId, orgId)),
    db
      .select({ value: count() })
      .from(memberships)
      .where(
        and(eq(memberships.organisationId, orgId), eq(memberships.status, "active")),
      ),
  ]);
  return {
    maintenanceRequests: jobRows[0]?.value ?? 0,
    sites: siteRows[0]?.value ?? 0,
    units: unitRows[0]?.value ?? 0,
    members: memberRows[0]?.value ?? 0,
  };
}

export async function GET(request: Request) {
  await ensureDatabase();
  try {
    const context = await scopedDb(request);
    const row = await readUser(context.db, context.identityEmail);

    /*
     * `?scope=theme` — the read-back that makes `theme_preference` mean
     * something.
     *
     * The column was written by every theme picker in the app and read back by
     * nothing, so a person who chose Light on their laptop was handed the
     * default on their phone. `theme-toggle.tsx` now reconciles the two once
     * per browser per account, and this is what it asks.
     *
     * It is a separate shape rather than the full account payload because it
     * runs on ARRIVAL, on every hard page load. The payload below counts jobs,
     * sites, units and members and lists every workspace the identity can
     * reach; none of that is needed to answer "which theme did this person
     * choose", and charging four aggregate queries for it on every load is how
     * a small convenience becomes a page-weight defect. The user id travels
     * with it because the marker the client stores is keyed on the account, not
     * a boolean — that is what lets a second person signing in on the same
     * browser take their own preference.
     *
     * `context.authenticated` IS LOAD-BEARING, and was added after measuring
     * the fault. In development `demoIdentityAllowed()` is true, so a browser
     * that has never signed in still resolves to a seeded identity and this
     * route still answers 200. Verified over Playwright: a fresh context with
     * empty storage loaded /dashboard, painted dark before paint as it should,
     * and then adopted `super-admin@test.maintsupp.com`'s stored "system" a
     * second later and repainted LIGHT on a light-preferring device — the
     * default defeated by somebody else's row. A preference is a property of an
     * ACCOUNT, so a caller who has not proved they are one has none, and gets
     * a null rather than the demo identity's. Production refuses these callers
     * outright; this makes the rule the same in both.
     */
    if (new URL(request.url).searchParams.get("scope") === "theme") {
      return Response.json({
        theme: {
          /**
           * Null when the identity has no `users` row, and null for a demo or
           * testing-switcher caller: nothing to adopt in either case.
           */
          userId: context.authenticated ? (row?.id ?? null) : null,
          preference: context.authenticated ? (row?.theme_preference ?? null) : null,
        },
      });
    }

    return Response.json({
      account: {
        profile: profilePayload(row, context.identityEmail),
        workspace: {
          id: context.organisation.id,
          name: context.organisation.name,
          slug: context.organisation.slug,
          /** monday's credits pill; here the workspace's plan tier. */
          planTier: context.organisation.planTier,
          primaryColour: context.organisation.primaryColour,
          status: context.organisation.status,
          createdAt: context.organisation.createdAt,
        },
        /** monday's "Spaces": every workspace this identity may switch to. */
        workspaces: context.activeOrganisations
          .filter((organisation) => context.organisationIds.includes(organisation.id))
          .map((organisation) => ({
            id: organisation.id,
            name: organisation.name,
            slug: organisation.slug,
            planTier: organisation.planTier,
            status: organisation.status,
            current: organisation.id === context.orgId,
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        usage: await usage(context.db, context.orgId),
        options: {
          workingStatuses: WORKING_STATUS_VALUES,
          supportedThemes: SUPPORTED_THEMES,
          avatarColours: AVATAR_COLOURS,
        },
        role: context.actor.role,
        crossOrganisation: context.crossOrganisation,
      },
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "The account could not be loaded.",
      },
      { status: 503 },
    );
  }
}

/**
 * Save the person's own details.
 *
 * Scoped to the resolved identity's own row — the email is never taken from the
 * body, so this cannot be used to edit somebody else. Password is deliberately
 * absent: it belongs to `/api/auth/password`, which another route owns.
 */
export async function PATCH(request: Request) {
  await ensureDatabase();
  try {
    const context = await scopedDb(request);
    const existing = await readUser(context.db, context.identityEmail);
    if (!existing) {
      return Response.json(
        {
          error:
            "This identity has no account record yet, so there is nothing to save.",
        },
        { status: 404 },
      );
    }

    const payload = (await request.json()) as Record<string, unknown>;
    const assignments: ReturnType<typeof sql>[] = [];

    if ("fullName" in payload) {
      const value = text(payload.fullName, 120);
      assignments.push(sql`full_name = ${value || null}`);
    }
    if ("jobTitle" in payload) {
      const value = text(payload.jobTitle, 120);
      assignments.push(sql`job_title = ${value || null}`);
    }
    if ("phone" in payload) {
      const value = text(payload.phone, 40);
      assignments.push(sql`phone = ${value || null}`);
    }
    if ("timezone" in payload) {
      const value = text(payload.timezone, 60);
      if (!validTimezone(value)) {
        return Response.json(
          { error: "Choose a valid time zone." },
          { status: 400 },
        );
      }
      assignments.push(sql`timezone = ${value}`);
    }
    if ("avatarColour" in payload) {
      const value = text(payload.avatarColour, 9).toLowerCase();
      if (value && !/^#[0-9a-f]{6}$/.test(value)) {
        return Response.json(
          { error: "Choose a valid avatar colour." },
          { status: 400 },
        );
      }
      assignments.push(sql`avatar_colour = ${value || null}`);
    }
    if ("themePreference" in payload) {
      const value = text(payload.themePreference, 20);
      if (!(SUPPORTED_THEMES as readonly string[]).includes(value)) {
        return Response.json(
          {
            // All three are implemented now, so the honest refusal is that the
            // value is not one of them — not that light does not exist.
            error: "Choose the dark, light or system theme.",
          },
          { status: 400 },
        );
      }
      assignments.push(sql`theme_preference = ${value}`);
    }
    if ("workingStatus" in payload) {
      const raw = payload.workingStatus;
      if (raw === null || raw === "") {
        assignments.push(sql`working_status = NULL`);
      } else {
        const value = text(raw, 40);
        if (!(WORKING_STATUS_VALUES as readonly string[]).includes(value)) {
          return Response.json(
            { error: "Choose a valid working status." },
            { status: 400 },
          );
        }
        assignments.push(sql`working_status = ${value}`);
      }
    }

    if (!assignments.length) {
      return Response.json({ error: "Nothing to save." }, { status: 400 });
    }

    assignments.push(sql`updated_at = CURRENT_TIMESTAMP`);
    await context.db.run(
      sql`UPDATE users SET ${sql.join(assignments, sql`, `)} WHERE id = ${existing.id}`,
    );

    const saved = await readUser(context.db, context.identityEmail);
    return Response.json({
      profile: profilePayload(saved, context.identityEmail),
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "The account could not be saved.",
      },
      { status: 503 },
    );
  }
}
