-- Hollywood — SEPARATE dashboard project that READS leads from the old "google crm leads" project.
-- Nothing is changed in the old project: this only reads google_leads / welcome_messages / service_map.
--
-- Run in the NEW project's SQL Editor, in this order:
--   1) schema.sql  2) dashboard_functions.sql  3) clinic_sessions_sync.sql  4) this file
--
-- Before running, fill in the 3 values in STEP A (old project's connection details).

-- ───────── STEP A: connect to the old project (read-only use) ─────────
-- Old project → Connect → Connection String → "Session pooler" shows: host, port 5432, user postgres.pmkhssgutixnpdljkiie
create extension if not exists postgres_fdw;

drop server if exists old_crm_server cascade;
create server old_crm_server foreign data wrapper postgres_fdw
    options (host 'aws-0-eu-west-1.pooler.supabase.com', port '5432', dbname 'postgres', sslmode 'require');
create user mapping for current_user server old_crm_server
  options (user 'postgres.pmkhssgutixnpdljkiie', password 'Khaled552002@');                -- ← old DB password

create schema if not exists old_crm;
import foreign schema public limit to (google_leads, welcome_messages, service_map)
  from server old_crm_server into old_crm;

-- ───────── STEP B: copy logic ─────────
alter table ha_leads add column if not exists ad_campaign_id bigint;
alter table ha_leads add column if not exists ad_group_id bigint;

create or replace function ha_upsert_google_lead(r jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  lid  text := r->>'lead_id';
  gcl  text := nullif(r->>'gcl_id', '');
  svc  text;
  st   text := case when r->>'status' = 'converted' then 'paid' else 'new' end;
begin
  if lid is null or coalesce((r->>'is_test')::boolean, false) or coalesce(gcl, '') like 'TEST\_%' then
    return;
  end if;

  -- service: from the welcome message for this lead, else from old_crm.service_map matched against the form answers
  select w.service into svc from old_crm.welcome_messages w where w.lead_key = lid and w.service is not null limit 1;
  if svc is null then
    select m.service into svc from old_crm.service_map m
    where lower(coalesce(r->>'answers', '')) like '%' || lower(m.match_key) || '%'
    order by length(m.match_key) desc limit 1;
  end if;

  insert into ha_leads (lead_id, created_at, updated_at, name, phone, service, channel, source,
    gclid, ad_campaign_id, ad_group_id, status, value, raw)
  values (
    'gl-' || lid,
    coalesce(nullif(r->>'submitted_at', '')::timestamptz, nullif(r->>'inserted_at', '')::timestamptz, now()),
    now(),
    r->>'full_name', r->>'phone', svc,
    case when lid like 'web-%' then 'website form'
         when coalesce(r->>'form_id', '') <> '' then 'google lead form'
         else 'other' end,
    case when gcl is not null or coalesce(r->>'form_id', '') <> '' or coalesce(r->>'campaign_id', '') <> '' then 'google' else 'unknown' end,
    gcl,
    case when r->>'campaign_id' ~ '^\d+$' then (r->>'campaign_id')::bigint end,
    case when r->>'adgroup_id'  ~ '^\d+$' then (r->>'adgroup_id')::bigint end,
    st,
    case when st = 'paid' then nullif(r->>'amount', '')::numeric end,
    r)
  on conflict (lead_id) do update set
    updated_at = now(), name = excluded.name, phone = excluded.phone,
    service = coalesce(excluded.service, ha_leads.service), channel = excluded.channel, source = excluded.source,
    gclid = coalesce(excluded.gclid, ha_leads.gclid),
    ad_campaign_id = coalesce(excluded.ad_campaign_id, ha_leads.ad_campaign_id),
    ad_group_id = coalesce(excluded.ad_group_id, ha_leads.ad_group_id),
    status = case when excluded.status = 'paid' or ha_status_rank(excluded.status) >= ha_status_rank(ha_leads.status)
                  then excluded.status else ha_leads.status end,
    value = coalesce(excluded.value, ha_leads.value),
    raw = excluded.raw;
end $$;
revoke all on function ha_upsert_google_lead(jsonb) from public;

-- Pull recent leads (new ones and ones whose status changed) every few minutes.
create or replace function ha_pull_old_leads(days int default 14)
returns int language plpgsql security definer set search_path = public as $$
declare n int := 0; r record;
begin
  for r in
    select * from old_crm.google_leads g
    where g.inserted_at >= now() - make_interval(days => days)
       or g.converted_at >= now() - make_interval(days => days)
  loop
    perform ha_upsert_google_lead(to_jsonb(r));
    n := n + 1;
  end loop;

  -- fill in the service once the welcome message has it
  update ha_leads l set service = w.service, updated_at = now()
  from old_crm.welcome_messages w
  where l.lead_id = 'gl-' || w.lead_key and w.service is not null and (l.service is null or l.service = '')
    and l.created_at >= now() - make_interval(days => days);

  return n;
end $$;
revoke all on function ha_pull_old_leads(int) from public;

-- First copy: everything that exists today
select ha_pull_old_leads(3650);

-- ───────── STEP C: run it automatically every 10 minutes ─────────
create extension if not exists pg_cron;
do $$ begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'ha-pull-old-leads';
  perform cron.schedule('ha-pull-old-leads', '*/10 * * * *', 'select ha_pull_old_leads(14)');
end $$;

-- Leads view: attribution by gclid (click) OR by the lead form's campaign/ad group ids,
-- status/value also lifted by clinic sessions with the same phone.
drop view if exists ha_v_leads;
create view ha_v_leads as
select
  l.lead_id, l.created_at, l.updated_at, l.name, l.phone, l.service, l.branch, l.channel, l.source,
  l.utm_source, l.utm_medium, l.utm_campaign, l.utm_term, l.gclid, l.ref, l.raw,
  case greatest(ha_status_rank(l.status), coalesce(s.rank, -9))
    when 5 then 'paid' when 4 then 'showed' when 3 then 'booked' when 2 then 'qualified' when 1 then 'contacted'
    when 0 then 'new' else l.status end as status,
  greatest(ha_status_rank(l.status), coalesce(s.rank, -9)) as status_rank,
  coalesce(l.value, s.paid_value) as value,
  s.sessions_booked, s.sessions_done,
  case when c.gclid is not null or l.ad_campaign_id is not null then 'google' else coalesce(l.source, 'unknown') end as source_eff,
  coalesce(c.campaign_name, ic.campaign_name) as ad_campaign,
  coalesce(c.ad_group_name, ig.ad_group_name) as ad_group,
  c.keyword as ad_keyword, c.match_type as ad_match_type
from ha_leads l
left join lateral (
  select
    max(case when x.done_at is not null then 5 when x.status ~* 'cancel|reject|no.?show' then -9 else 3 end) as rank,
    sum(x.net) filter (where x.done_at is not null) as paid_value,
    count(*) as sessions_booked,
    count(*) filter (where x.done_at is not null) as sessions_done
  from ha_sessions x
  where x.phone_norm = ha_norm_phone(l.phone)
    and coalesce(x.created_at, x.updated_at) >= l.created_at - interval '1 day'
) s on true
left join lateral (
  select c.* from ha_clicks c
  where c.gclid = l.gclid
     or (l.gclid is null and l.ref like 'G-%' and right(c.gclid, 8) = substr(l.ref, 3))
  order by (c.gclid = l.gclid) desc nulls last, c.date desc
  limit 1
) c on true
left join lateral (
  select d.campaign_name from ha_campaign_daily d where d.campaign_id = l.ad_campaign_id order by d.date desc limit 1
) ic on true
left join lateral (
  select a.ad_group_name from ha_adgroup_daily a where a.ad_group_id = l.ad_group_id order by a.date desc limit 1
) ig on true;

alter view ha_v_leads set (security_invoker = true);
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on ha_v_leads from anon, authenticated';
  end if;
end $$;


-- Check:  select channel, status, count(*) from ha_leads where lead_id like 'gl-%' group by 1, 2;
--         select * from cron.job_run_details order by start_time desc limit 5;
