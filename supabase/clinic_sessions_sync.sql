-- Hollywood — clinic sessions (from the clinic panel's Confirmation / Done webhooks) → dashboard.
-- A lead whose phone later gets a confirmed session becomes "booked"; a done session makes it "paid" with its net amount.
-- Run after schema.sql (and website_leads_sync.sql if you use it). Safe to re-run.

-- Egyptian phone → 20XXXXXXXXXX (handles 011…, +2011…, 002011…, "+20 +2011…")
create or replace function ha_norm_phone(raw text) returns text language sql immutable as $$
  select case
    when d ~ '^(20|0)*1[0-9]{9}$' then '20' || substring(d from '(1[0-9]{9})$')
    when d like '00%' then substr(d, 3)
    else nullif(d, '') end
  from (select regexp_replace(coalesce(raw, ''), '\D', '', 'g') as d) x
$$;

create table if not exists ha_sessions (
  session_record_id bigint primary key,
  phone_norm   text,
  patient_name text,
  title        text,
  session_date date,
  session_time text,
  status       text,
  net          numeric,
  done_at      timestamptz,
  created_at   timestamptz,
  last_event   text,
  updated_at   timestamptz default now(),
  raw          jsonb
);
create index if not exists ha_sessions_phone_idx on ha_sessions (phone_norm);
alter table ha_sessions enable row level security;

-- Payload: {"secret":"…", "event":"confirmation"|"done", "session": <the clinic webhook body>}
create or replace function ha_ingest_session(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s jsonb := coalesce(payload->'session', payload->'body', '{}'::jsonb);
        ev text := coalesce(payload->>'event', s->>'event', '');
begin
  if payload->>'secret' is distinct from (select value from ha_settings where key = 'ingest_secret') then
    raise exception 'bad secret' using errcode = '28000';
  end if;
  if (s->>'session_record_id') is null then
    return jsonb_build_object('ok', false, 'reason', 'no session_record_id');
  end if;

  insert into ha_sessions (session_record_id, phone_norm, patient_name, title, session_date, session_time, status,
    net, done_at, created_at, last_event, updated_at, raw)
  values (
    (s->>'session_record_id')::bigint,
    ha_norm_phone(coalesce(s#>>'{patient,phone}', s->>'phone')),
    coalesce(s#>>'{patient,name}', s->>'name'),
    coalesce(s->>'session_title', s->>'title'),
    case when s->>'date' ~ '^\d{4}-\d{2}-\d{2}' then (left(s->>'date', 10))::date end,
    s->>'time',
    s->>'status',
    nullif(regexp_replace(coalesce(s->>'net', s->>'cost', ''), '[^0-9.]', '', 'g'), '')::numeric,
    -- only trust done_at when this is the Done webhook (the confirmation payload can carry an old done_at)
    case when ev ~* 'done|complete' then coalesce(nullif(s->>'done_at', '')::timestamptz, now()) end,
    nullif(s->>'created_at', '')::timestamptz,
    ev, now(), s)
  on conflict (session_record_id) do update set
    phone_norm = coalesce(excluded.phone_norm, ha_sessions.phone_norm),
    patient_name = coalesce(excluded.patient_name, ha_sessions.patient_name),
    title = coalesce(excluded.title, ha_sessions.title),
    session_date = coalesce(excluded.session_date, ha_sessions.session_date),
    session_time = coalesce(excluded.session_time, ha_sessions.session_time),
    status = coalesce(excluded.status, ha_sessions.status),
    net = coalesce(excluded.net, ha_sessions.net),
    done_at = coalesce(excluded.done_at, ha_sessions.done_at),
    created_at = coalesce(ha_sessions.created_at, excluded.created_at),
    last_event = excluded.last_event, updated_at = now(), raw = excluded.raw;

  return jsonb_build_object('ok', true, 'session_record_id', (s->>'session_record_id')::bigint);
end $$;

revoke all on function ha_ingest_session(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function ha_ingest_session(jsonb) to anon, authenticated, service_role';
  end if;
end $$;

-- Rebuild the leads view: a lead's status/value also comes from the clinic sessions booked
-- with the same phone on or after the lead date (sessions before it = an existing patient, not this lead).
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
  case when c.gclid is not null then 'google' else coalesce(l.source, 'unknown') end as source_eff,
  c.campaign_name as ad_campaign, c.ad_group_name as ad_group, c.keyword as ad_keyword, c.match_type as ad_match_type
from ha_leads l
left join lateral (
  select
    max(case when x.done_at is not null then 5
             when x.status ~* 'cancel|reject|no.?show' then -9
             else 3 end) as rank,
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
) c on true;

alter view ha_v_leads set (security_invoker = true);
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on ha_v_leads from anon, authenticated';
  end if;
end $$;
