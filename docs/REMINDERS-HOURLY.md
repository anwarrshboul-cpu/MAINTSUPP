# Hourly reminder dispatch on Production

Reminder rules carry their own send time, so `/api/cron/reminders` must run
hourly. Vercel's Hobby plan allows daily crons only, so Production is driven
from the database instead (set up 2026-10-04):

| Piece | Where |
| --- | --- |
| Schedule | Supabase `pg_cron` job **`maintsupp-reminders-hourly`**, `2 * * * *` (two past every hour, UTC) |
| Call | `pg_net` `POST https://maintsupp.com/api/cron/reminders` with header `x-cron-secret` |
| Key | Supabase Vault secret **`reminder_trigger_secret`** = Vercel Production env **`REMINDER_TRIGGER_SECRET`** |
| Endpoint check | `triggerKeyMatches` in `app/api/cron/reminders/route.ts` — the key opens this endpoint only, never retention or the daily run |
| Safety net | `/api/cron/daily` (05:40 UTC) also dispatches anything due — `dispatchDueRemindersDaily` |

Double runs are harmless: each send is claimed with a UNIQUE insert on
(reminder, local day) before it is sent.

## Checking it

```sql
-- Recent runs of the job
select status, return_message, start_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'maintsupp-reminders-hourly')
order by start_time desc limit 10;

-- What the endpoint answered
select status_code, left(content::text, 300), created
from net._http_response order by created desc limit 10;
```

A 401 means the two copies of the key differ.

## Rotating the key

1. Generate a new value (64 hex characters).
2. Vercel → Project → Settings → Environment Variables → `REMINDER_TRIGGER_SECRET` (Production) → set it, then redeploy.
3. In Supabase SQL: `select vault.update_secret((select id from vault.secrets where name = 'reminder_trigger_secret'), '<new value>');`

## Stopping it

```sql
select cron.unschedule('maintsupp-reminders-hourly');
```

If the project moves to Vercel Pro, declare the hourly cron in
`vercel/build-output.mjs` and unschedule this job in the same change.
