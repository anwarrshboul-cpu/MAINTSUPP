-- Twenty-five cells that hold the literal string "[object Object]".
--
-- The monday API returns a status cell as a pair: `text` carries the label,
-- `value` carries a JSON object. The legacy importer read `text`, and where
-- `text` was empty it fell through to `value` and stringified the object. That
-- one fallback produced every occurrence: 22 in `priority`, 2 in `engineer`,
-- 1 in `category`.
--
-- What the object said was `{"index":5,…}` on a column declaring labels at
-- indices 0-3. Index 5 is monday's blank chip — the column was UNSET. So the
-- honest repair is NULL, not a guess at what the engineer or priority "should"
-- have been. Nothing is being decided here that the source data did not
-- already say.
--
-- `app/(app)/portal/views/overview-series.ts` already refuses these values at
-- display time, so the dashboards read correctly with or without this repair.
-- This makes the stored data agree with what is shown, so the next piece of
-- code to read these columns does not have to know the history.
--
-- REVERSAL is at the bottom of this file. The ids are recorded rather than
-- re-derived, because after the repair there is no way to find them again.

begin;

update portal.maintenance_requests set engineer = null
 where engineer = '[object Object]';

update portal.maintenance_requests set priority = null
 where priority = '[object Object]';

update portal.maintenance_requests set category = null
 where category = '[object Object]';

-- Expect 0. Anything else means a new import reintroduced the fallback.
select count(*) as remaining
  from portal.maintenance_requests
 where engineer = '[object Object]'
    or priority = '[object Object]'
    or category = '[object Object]';

commit;

-- ---------------------------------------------------------------- reversal --
-- Verified against the live database on 2026-08-17, before the update above.
--
-- update portal.maintenance_requests set category = '[object Object]'
--  where id = 'req_ef1959f5aeba4f559882a1b671b69f87';
--
-- update portal.maintenance_requests set engineer = '[object Object]'
--  where id in (
--    'req_b21f8d59992d40f485179ecb1fbf299a',
--    'req_deccc55a1ce541cc95b3fec55d68c368'
--  );
--
-- update portal.maintenance_requests set priority = '[object Object]'
--  where id in (
--    'req_c45e09ac29184da3951d16b0418370e0', 'req_8d5918f56c1148b291cbf86a06ba6ff3',
--    'req_57feb34e129f458485ce47d7d2774dce', 'req_d99ee1fceb574d6daaad08e0e602eba0',
--    'req_a0ba1948a4ff43fea95fee28456aa3c8', 'req_833bcaa8a8154a1582605ed3c28e6237',
--    'req_4a36d269008841eeb9205945c77e60d2', 'req_ffd64842876b41348009676a6ff432b0',
--    'req_07a06252d07140df92145e34bbb78fe3', 'req_0dabc109c1ff48b59eab6d9ecc2fd9d3',
--    'req_3ad6015940724165b60888271b8c45cb', 'req_ad059ab1e52e4450ac7618476f88adeb',
--    'req_106983c5311d490fb18744bb2e094874', 'req_e47cde9ad6d14873b7905fa818eaefa3',
--    'req_0c25998e852d458b83ad5cc58b82a975', 'req_617383d5f5aa456a8097d0ed44a11fde',
--    'req_e12bc2c3e5d94520add8477642e829b9', 'req_5d205a2bfbdc496eb68001b58e871724',
--    'req_a4ff9ad3d70a4a1689f82c4fd26678db', 'req_737bd19ce21d42dab3c5137f2913f79e',
--    'req_43dd7c9cc4d34214b474d135d71067cc', 'req_c41fcb529c024129abdd4187a57460b8'
--  );
