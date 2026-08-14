-- 0007 — account settings: typed key/value, owner-owned, with an audit trail.

/*
 * Why a table rather than another environment variable.
 *
 * The first setting this holds — "hide money fields on shared links" — already
 * exists as `HIDE_MONEY_ON_SHARE` in the API's environment. That works, and it
 * has two properties a product switch must not have: changing it needs whoever
 * holds the Railway dashboard plus a restart, and it leaves no record of who
 * changed it or when. A switch the owner is expected to flip is a feature, not
 * a deployment detail.
 *
 * PRECEDENCE, stated here and implemented in `apps/api/src/lib/settings.ts`:
 *
 *     a row in this table  >  the environment variable  >  the code's default
 *
 * which is exactly why this migration seeds NO rows. Seeding
 * `hide_money_on_share` with its default would silently retire the environment
 * variable on every deployment that still sets it — the value in Railway would
 * stop taking effect and nothing would say so. "No row" has to keep meaning
 * "nobody has made this decision in the product yet".
 *
 * Account-level, so the key is the whole primary key. There is no
 * organisation_id: these settings are the account's, and the owner is the only
 * account that may touch them. Per-organisation settings, if they are ever
 * wanted, need a composite key and a different access rule — that is a
 * migration, not a nullable column bolted on here.
 */

do $$ begin
  create type setting_value_type as enum ('boolean', 'integer', 'text', 'json');
exception when duplicate_object then null; end $$;

create table if not exists settings (
  key text primary key,

  /*
   * Typed, and the type is enforced rather than described.
   *
   * `value` is jsonb so one table can hold a switch, a threshold and a string
   * without a column per shape. jsonb alone would happily store the string
   * "false" in a boolean setting, and every reader of that row would then see
   * a non-empty string, decide it is truthy, and turn ON a switch the owner
   * turned off. The CHECK below is what makes that impossible at the source
   * instead of in each caller.
   */
  value_type setting_value_type not null,
  value jsonb not null,

  -- What this switch does, in the owner's language. Shown on the settings
  -- screen so the meaning of a key travels with the row rather than living
  -- only in whichever UI happened to render it.
  description text,

  updated_by uuid references profiles(id) on delete set null,
  -- Denormalised for the same reason `activity_log.actor_email` is: the point
  -- of "who last changed this" is that it still answers after the profile has
  -- been deleted, and a foreign key that nulls on delete erases exactly the
  -- record most worth keeping.
  updated_by_email text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint settings_value_matches_type check (
    case value_type
      when 'boolean' then jsonb_typeof(value) = 'boolean'
      when 'text' then jsonb_typeof(value) = 'string'
      when 'integer' then
        jsonb_typeof(value) = 'number'
        -- A JSON number covers 1.5 as happily as 1. An "integer" setting that
        -- can hold a fraction is not typed, it is merely labelled.
        and (value #>> '{}')::numeric = trunc((value #>> '{}')::numeric)
      when 'json' then true
    end
  )
);

/*
 * The audit trail.
 *
 * A separate table rather than `activity_log`, for a concrete reason:
 * `activity_log.entity_id` is a uuid column and a setting is identified by a
 * text key, so the one field that would say WHICH setting changed cannot hold
 * it. The API writes an activity_log row too, for the global feed, but this is
 * the record that can be read back per key and in order.
 *
 * There is deliberately no foreign key to `settings(key)`. Deleting a setting
 * — reverting it to the environment's value — must not erase the evidence that
 * it once existed and who set it.
 */
create table if not exists settings_audit (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  -- Null on the first write: there was no row before, the value came from the
  -- environment or the default. That null is information, not a gap.
  old_value jsonb,
  new_value jsonb not null,
  changed_by uuid references profiles(id) on delete set null,
  changed_by_email text not null,
  created_at timestamptz not null default now()
);

create index if not exists settings_audit_key_idx
  on settings_audit (key, created_at desc);

drop trigger if exists settings_touch on settings;
create trigger settings_touch before update on settings
  for each row execute function touch_updated_at();

comment on table settings is
  'Account-level switches. A row here overrides the environment variable of the same meaning; no row means the environment (then the code default) decides. See apps/api/src/lib/settings.ts.';
