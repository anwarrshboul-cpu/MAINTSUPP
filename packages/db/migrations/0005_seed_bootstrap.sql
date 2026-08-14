-- 0005 — the founding owner and the demo client organisation.
--
-- Idempotent: every statement is `on conflict do nothing`, so re-running is
-- safe and re-seeding never resurrects a store somebody deliberately closed.
--
-- Everything the demo client owns carries `is_demo = true`, so
-- `delete from organisations where is_demo` clears it in one statement when the
-- real portfolio arrives.

/*
 * The owner is declared, not created.
 *
 * No user row, no password. Whoever signs up with this address is provisioned
 * as `owner` instead of the pending_approval default. That way the founding
 * account has a password its owner chose, and there is no seeded credential
 * sitting in a migration file for anyone who reads the repository.
 */
insert into role_bootstrap (email, role, note)
values (
  'anwarrshboul@gmail.com',
  'owner',
  'Product owner. Becomes an active owner on first sign-up.'
)
on conflict (email) do nothing;

insert into organisations (name, slug, is_demo)
values ('Demo Retail Group', 'demo-retail-group', true)
on conflict (slug) do nothing;

/*
 * The 21 stores, exactly as the client's own list names them.
 *
 * The separator is an EN DASH (U+2013), not a hyphen — matching the source
 * list. It matters because site names are matched by string when historic
 * monday rows are imported, and "Birmingham - Bullring" would not find
 * "Birmingham – Bullring".
 */
insert into sites (organisation_id, name, is_demo)
select o.id, s.name, true
from organisations o
cross join (values
  ('Birmingham – Bullring'),
  ('Solihull – Touchwood'),
  ('Westfield – White City'),
  ('Aldgate – Whitechapel Road'),
  ('Brent Cross'),
  ('Brighton – Churchill Square'),
  ('Bristol – Cabot Circus'),
  ('Cardiff – Grand Arcade'),
  ('Dudley – Merry Hill'),
  ('Glasgow – Silverburn'),
  ('Greenhithe – Bluewater'),
  ('Manchester – Arndale'),
  ('Manchester – Trafford Centre'),
  ('Milton Keynes – The Centre'),
  ('Nottingham – Victoria Centre'),
  ('Reading – The Oracle'),
  ('Sheffield – Meadowhall'),
  ('Southall – The Broadway'),
  ('Watford – Atria'),
  ('Westfield – Stratford'),
  ('Wood Green – High Road')
) as s(name)
where o.slug = 'demo-retail-group'
on conflict do nothing;
