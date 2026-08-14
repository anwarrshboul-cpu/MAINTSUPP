/**
 * Account settings: the catalogue, and the one place precedence is decided.
 *
 * PRECEDENCE — read this before changing anything here:
 *
 *     a row in `settings`  >  the environment variable  >  the code's default
 *
 * The database is the authority. A row exists only because somebody with the
 * owner account decided something in the product, and that decision must beat
 * a value left in Railway from before the screen existed. The environment
 * variable is the fallback for exactly one case: no row, which means nobody
 * has made that decision yet — a fresh deployment, or one still configured the
 * old way. The literal default in this file is the last resort, so a setting
 * always has a value even with no row and no variable.
 *
 * The consequence worth stating: setting `HIDE_MONEY_ON_SHARE=true` in Railway
 * stops having any effect the moment the owner touches that switch in the
 * portal. That is the intended direction of authority, and it is why the
 * settings screen shows which source each value came from — an owner who
 * cannot see why a value is what it is will change the wrong thing.
 *
 * There is NO cache. A toggle the owner flips must take effect on the next
 * request, and a primary-key lookup on a table with a handful of rows is
 * cheaper than explaining to somebody why the switch they just moved has not
 * done anything yet.
 */
import type { Db } from "../../../../packages/db/src/client.ts";

export type SettingType = "boolean" | "integer" | "text" | "json";

export type SettingDefinition = {
  key: string;
  type: SettingType;
  /** The switch, in the owner's language. */
  label: string;
  description: string;
  /** The variable this setting took over from, if any. */
  envVar?: string;
  /** Used when there is neither a row nor an environment variable. */
  fallback: unknown;
};

/** The setting the share page reads. Exported so nothing has to retype it. */
export const HIDE_MONEY_ON_SHARE = "hide_money_on_share";

/**
 * The catalogue.
 *
 * Kept in code rather than seeded as rows, because a key with no row is the
 * normal state — see the precedence note above — so the type, the label and
 * the default have to be known without one.
 */
export const SETTINGS: readonly SettingDefinition[] = [
  {
    key: HIDE_MONEY_ON_SHARE,
    type: "boolean",
    label: "Hide money fields on shared links",
    description:
      "When off, a job opened through a share link shows the full ticket, cost of works and quotes included. Turn it on to strip cost, invoice reference, approver and quotes from that page — the rest of the ticket is unchanged, and nothing changes for people signed in.",
    envVar: "HIDE_MONEY_ON_SHARE",
    // OFF: the owner's decision is that a shared link shows the full ticket.
    fallback: false,
  },
];

export const settingDefinition = (key: string): SettingDefinition | undefined =>
  SETTINGS.find((definition) => definition.key === key);

export type SettingSource = "database" | "environment" | "default";

export type EffectiveSetting = {
  key: string;
  type: SettingType;
  label: string;
  description: string;
  value: unknown;
  source: SettingSource;
  envVar: string | null;
  /** What the environment says, whether or not it is winning. */
  envValue: string | null;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

type SettingRow = {
  key: string;
  value: unknown;
  value_type: SettingType;
  updated_at: string | null;
  updated_by_email: string | null;
};

/**
 * Reads an environment variable as `type`.
 *
 * Boolean is the exact string "true" and nothing else — the same test
 * `public.ts` applied before this table existed. Loosening it to accept "yes"
 * or "1" would change what an existing deployment's value MEANS at the moment
 * authority moved to the database, which is the one thing a migration of
 * authority must not do.
 *
 * Anything unparseable returns undefined and falls through to the code's
 * default, rather than becoming NaN or the string itself.
 */
function fromEnv(definition: SettingDefinition): unknown | undefined {
  if (!definition.envVar) return undefined;
  const raw = process.env[definition.envVar];
  if (raw === undefined || raw.trim() === "") return undefined;

  switch (definition.type) {
    case "boolean":
      return raw === "true";
    case "integer": {
      const parsed = Number(raw);
      return Number.isInteger(parsed) ? parsed : undefined;
    }
    case "text":
      return raw;
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
  }
}

/** `jsonb` comes back parsed from PGlite and as text from postgres.js. */
function parseValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    // A jsonb column that will not parse as JSON is a driver surprise, not a
    // setting. Returning the raw string here would hand a caller a value of
    // the wrong type; undefined falls through to the environment instead.
    return undefined;
  }
}

function effective(
  definition: SettingDefinition,
  row: SettingRow | undefined,
): EffectiveSetting {
  const stored = row ? parseValue(row.value) : undefined;
  const env = fromEnv(definition);

  const [value, source]: [unknown, SettingSource] =
    stored !== undefined
      ? [stored, "database"]
      : env !== undefined
        ? [env, "environment"]
        : [definition.fallback, "default"];

  return {
    key: definition.key,
    type: definition.type,
    label: definition.label,
    description: definition.description,
    value,
    source,
    envVar: definition.envVar ?? null,
    envValue: definition.envVar ? (process.env[definition.envVar] ?? null) : null,
    updatedAt: row?.updated_at ?? null,
    updatedByEmail: row?.updated_by_email ?? null,
  };
}

/** Every known setting, with where its current value came from. */
export async function readSettings(db: Db): Promise<EffectiveSetting[]> {
  const rows = await db.query<SettingRow>(
    `select key, value, value_type::text as value_type,
            updated_at::text as updated_at, updated_by_email
       from settings where key = any($1::text[])`,
    [SETTINGS.map((definition) => definition.key)],
  );
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return SETTINGS.map((definition) => effective(definition, byKey.get(definition.key)));
}

export async function readSetting(
  db: Db,
  key: string,
): Promise<EffectiveSetting | undefined> {
  const definition = settingDefinition(key);
  if (!definition) return undefined;
  const [row] = await db.query<SettingRow>(
    `select key, value, value_type::text as value_type,
            updated_at::text as updated_at, updated_by_email
       from settings where key = $1`,
    [key],
  );
  return effective(definition, row);
}

/**
 * Whether a share link should hide cost, invoice reference, approver and
 * quotes. Read by `routes/public.ts`, which is the only caller that matters.
 */
export async function hideMoneyOnShare(db: Db): Promise<boolean> {
  const setting = await readSetting(db, HIDE_MONEY_ON_SHARE);
  return setting?.value === true;
}
