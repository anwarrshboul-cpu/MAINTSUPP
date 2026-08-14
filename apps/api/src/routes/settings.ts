import { Hono } from "hono";
import { canManageSettings } from "../lib/access.ts";
import { requireActor, requireCapability, type Env } from "../lib/middleware.ts";
import { str } from "../lib/http.ts";
import {
  readSetting,
  readSettings,
  settingDefinition,
  type SettingDefinition,
} from "../lib/settings.ts";

/**
 * settings — mounted at /settings.
 *
 * Account-level switches, owner only, both to read and to write. The rule
 * lives in `access.ts`; this file only composes it.
 *
 * `lib/settings.ts` holds the catalogue and decides precedence (a row beats
 * the environment beats the code's default). Nothing here reads
 * `process.env` directly — one place decides what a setting IS, or two places
 * eventually disagree about it.
 */
export const settings = new Hono<Env>();

settings.use("*", requireActor);
settings.use(
  "*",
  requireCapability(canManageSettings, "Only the owner can see account settings."),
);

/** Every known setting, with its value, its source and who last changed it. */
settings.get("/", async (c) => {
  return c.json({ settings: await readSettings(c.get("db")) });
});

/*
 * Registered BEFORE `/:key`. Hono matches in registration order, so with these
 * swapped `/settings/audit` would be read as the key "audit" and answer 404
 * for a setting nobody has ever heard of.
 */
settings.get("/audit", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
  const key = str(c.req.query("key"), 120);

  const params: unknown[] = [];
  let where = "";
  if (key) {
    params.push(key);
    where = ` where key = $${params.length}`;
  }

  const entries = await c.get("db").query(
    `select id::text, key, old_value, new_value, changed_by_email, created_at::text
       from settings_audit${where}
      order by created_at desc limit $${params.length + 1}`,
    [...params, limit],
  );
  return c.json({ entries });
});

settings.get("/:key", async (c) => {
  const setting = await readSetting(c.get("db"), c.req.param("key"));
  if (!setting) return c.json({ error: "Unknown setting." }, 404);
  return c.json({ setting });
});

/**
 * Change one setting.
 *
 * The value is CHECKED against the catalogue's type, never coerced. `Boolean("false")`
 * is `true`, so accepting the string a form might send would turn a switch on
 * at the exact moment somebody turned it off — and this switch decides whether
 * a public link shows money. The database's own CHECK refuses the same shape,
 * so a caller that bypassed this route could not corrupt the row either.
 */
settings.post("/:key", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const definition = settingDefinition(c.req.param("key"));
  if (!definition) return c.json({ error: "Unknown setting." }, 404);

  const body = await c.req.json().catch(() => ({}));
  if (!("value" in body)) return c.json({ error: "Send a value." }, 400);

  const invalid = typeError(definition, body.value);
  if (invalid) return c.json({ error: invalid }, 400);

  /*
   * One transaction for the row, its audit entry and the activity feed.
   *
   * A setting that changed with no audit row is worse than one that did not
   * change: the trail is the whole reason this is a table rather than an
   * environment variable, and a trail with holes in it is one nobody can rely
   * on in an argument about who turned money off.
   */
  await db.transaction(async (tx) => {
    const [previous] = await tx.query<{ value: unknown }>(
      "select value from settings where key = $1",
      [definition.key],
    );

    await tx.query(
      `insert into settings (key, value_type, value, description, updated_by, updated_by_email)
       values ($1, $2::setting_value_type, $3::jsonb, $4, $5, $6)
       on conflict (key) do update
          set value = excluded.value,
              value_type = excluded.value_type,
              description = excluded.description,
              updated_by = excluded.updated_by,
              updated_by_email = excluded.updated_by_email`,
      [
        definition.key,
        definition.type,
        JSON.stringify(body.value),
        definition.description,
        actor.profileId,
        actor.email,
      ],
    );

    await tx.query(
      `insert into settings_audit (key, old_value, new_value, changed_by, changed_by_email)
       values ($1, $2::jsonb, $3::jsonb, $4, $5)`,
      [
        definition.key,
        // Null, not the effective value, when there was no row: "it came from
        // the environment" and "it was already false" are different histories.
        previous ? JSON.stringify(previous.value) : null,
        JSON.stringify(body.value),
        actor.profileId,
        actor.email,
      ],
    );

    await tx.query(
      `insert into activity_log (actor_profile_id, actor_email, action, entity_type, detail)
       values ($1,$2,'setting.changed','setting',$3)`,
      // No entity_id: that column is a uuid and a setting is identified by a
      // text key. The key travels in `detail`, and `settings_audit` is the
      // record that can be read back per key.
      [actor.profileId, actor.email, JSON.stringify({ key: definition.key, value: body.value })],
    );
  });

  return c.json({ ok: true, setting: await readSetting(db, definition.key) });
});

/** The refusal message for a value of the wrong shape, or null if it is fine. */
function typeError(definition: SettingDefinition, value: unknown): string | null {
  switch (definition.type) {
    case "boolean":
      return typeof value === "boolean" ? null : "That setting is on or off.";
    case "integer":
      return Number.isInteger(value) ? null : "That setting is a whole number.";
    case "text":
      return typeof value === "string" ? null : "That setting is text.";
    case "json":
      return value === undefined ? "Send a value." : null;
  }
}
