-- Hollywood — website visitor tracking, phone-capture leads, lead CRM fields and the read functions
-- the Action plan / Leads CRM / Tracking tabs use.
--
-- Run LAST, after: schema.sql, dashboard_functions.sql, clinic_sessions_sync.sql and
-- google_leads_sync.sql (or pull_from_old_project.sql). Safe to re-run.
-- If you re-run any of those files later (they rebuild ha_v_leads), run this file again afterwards.
--
-- How a lead is born from tracking: the moment a visitor types a mobile number into ANY field on the site
-- (no submit needed, no booking needed) the website script sends it to the dashboard's /api/track,
-- which calls ha_track() → a lead is created (or, if that phone already became a lead in the last 30 days,
-- the existing lead is enriched with the visit data instead of creating a duplicate).

-- ───────────────────────── Visitors & events ─────────────────────────
create table if not exists ha_visitors (
  visitor_id    text primary key,              -- random id stored in the visitor's browser
  first_seen    timestamptz default now(),
  last_seen     timestamptz default now(),
  last_session  text,
  visits        int default 1,                 -- sessions (30 min of inactivity = new session)
  pageviews     int default 0,
  wa_clicks     int default 0,
  call_clicks   int default 0,
  form_submits  int default 0,
  phone         text,
  phone_norm    text,
  name          text,
  gclid         text,
  ref           text,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  utm_term      text,
  landing_page  text,
  referrer      text,
  device        text,
  last_page     text,
  lead_id       text
);
create index if not exists ha_visitors_phone_idx on ha_visitors (phone_norm);
create index if not exists ha_visitors_lead_idx  on ha_visitors (lead_id);

create table if not exists ha_events (
  id          bigserial primary key,
  ts          timestamptz default now(),
  visitor_id  text,
  session_id  text,
  event       text,                            -- pageview, wa_click, call_click, form_submit, phone
  page        text,
  detail      jsonb
);
create index if not exists ha_events_ts_idx      on ha_events (ts);
create index if not exists ha_events_session_idx on ha_events (session_id);

alter table ha_visitors enable row level security;
alter table ha_events   enable row level security;

-- ───────────────────────── Lead CRM fields (edited from the dashboard) ─────────────────────────
alter table ha_leads add column if not exists ad_campaign_id bigint;
alter table ha_leads add column if not exists ad_group_id    bigint;
alter table ha_leads add column if not exists visitor_id     text;
alter table ha_leads add column if not exists crm_status     text;         -- set by the team in the dashboard
alter table ha_leads add column if not exists crm_note       text;
alter table ha_leads add column if not exists contacted_at   timestamptz;  -- first time the team reached out
alter table ha_leads add column if not exists next_follow_up timestamptz;
alter table ha_leads add column if not exists crm_updated_at timestamptz;
create index if not exists ha_leads_phone_norm_idx on ha_leads (ha_norm_phone(phone));

-- ───────────────────────── Tracking ingest (called by the dashboard server, never by anon) ─────────────────────────
-- Payload: {"v": visitor id, "s": session id, "e": event, "page": "/path", "referrer": "...", "device": "mobile",
--           "src": {gclid, ref, utm_source, utm_medium, utm_campaign, utm_term, landing_page},
--           "phone": "...", "name": "...", "service": "...", "href": "..."}
create or replace function ha_track(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  vid text := left(p->>'v', 64);
  sid text := nullif(left(p->>'s', 64), '');
  ev  text := lower(coalesce(p->>'e', ''));
  pg  text := nullif(left(p->>'page', 300), '');
  src jsonb := case when jsonb_typeof(p->'src') = 'object' then p->'src' else '{}'::jsonb end;
  ph  text := nullif(left(btrim(coalesce(p->>'phone', '')), 40), '');
  nm  text := nullif(left(btrim(coalesce(p->>'name', '')), 120), '');
  svc text := nullif(left(btrim(coalesce(p->>'service', '')), 120), '');
  pn  text;
  lid text;
  vr  ha_visitors%rowtype;
begin
  if vid is null or vid !~ '^[A-Za-z0-9_-]{8,64}$' then
    return jsonb_build_object('ok', false, 'reason', 'bad visitor id');
  end if;
  if ev not in ('pageview', 'wa_click', 'call_click', 'form_submit', 'phone') then
    return jsonb_build_object('ok', false, 'reason', 'unknown event');
  end if;

  if ph is not null then
    pn := ha_norm_phone(ph);
    if pn !~ '^(201[0125][0-9]{8}|[1-9][0-9]{9,14})$' then pn := null; end if;
  end if;
  if ev = 'phone' and pn is null then
    return jsonb_build_object('ok', false, 'reason', 'not a phone number');
  end if;

  insert into ha_visitors as v (visitor_id, first_seen, last_seen, last_session, visits, pageviews, wa_clicks, call_clicks,
    form_submits, gclid, ref, utm_source, utm_medium, utm_campaign, utm_term, landing_page, referrer, device, last_page)
  values (vid, now(), now(), sid, 1,
    (ev = 'pageview')::int, (ev = 'wa_click')::int, (ev = 'call_click')::int, (ev = 'form_submit')::int,
    nullif(left(src->>'gclid', 200), ''), nullif(left(src->>'ref', 40), ''),
    nullif(left(src->>'utm_source', 100), ''), nullif(left(src->>'utm_medium', 100), ''),
    nullif(left(src->>'utm_campaign', 200), ''), nullif(left(src->>'utm_term', 200), ''),
    coalesce(nullif(left(src->>'landing_page', 300), ''), pg),
    nullif(left(p->>'referrer', 300), ''), nullif(left(p->>'device', 20), ''), pg)
  on conflict (visitor_id) do update set
    last_seen    = now(),
    visits       = v.visits + case when excluded.last_session is distinct from v.last_session and excluded.last_session is not null then 1 else 0 end,
    last_session = coalesce(excluded.last_session, v.last_session),
    pageviews    = v.pageviews + excluded.pageviews,
    wa_clicks    = v.wa_clicks + excluded.wa_clicks,
    call_clicks  = v.call_clicks + excluded.call_clicks,
    form_submits = v.form_submits + excluded.form_submits,
    gclid        = coalesce(excluded.gclid, v.gclid),          -- the latest ad click wins
    ref          = coalesce(excluded.ref, v.ref),
    utm_source   = coalesce(excluded.utm_source, v.utm_source),
    utm_medium   = coalesce(excluded.utm_medium, v.utm_medium),
    utm_campaign = coalesce(excluded.utm_campaign, v.utm_campaign),
    utm_term     = coalesce(excluded.utm_term, v.utm_term),
    landing_page = coalesce(v.landing_page, excluded.landing_page),
    referrer     = coalesce(v.referrer, excluded.referrer),
    device       = coalesce(excluded.device, v.device),
    last_page    = coalesce(excluded.last_page, v.last_page)
  returning * into vr;

  insert into ha_events (visitor_id, session_id, event, page, detail)
  values (vid, sid, ev, pg, jsonb_strip_nulls(jsonb_build_object('href', nullif(left(p->>'href', 300), ''))));

  -- A phone number typed anywhere (or sent with a form) = a lead.
  if pn is null then
    return jsonb_build_object('ok', true);
  end if;

  update ha_visitors set phone = ph, phone_norm = pn, name = coalesce(nm, name) where visitor_id = vid;

  -- same phone already a lead in the last 30 days? enrich it instead of creating a duplicate
  select l.lead_id into lid from ha_leads l
  where ha_norm_phone(l.phone) = pn and l.created_at > now() - interval '30 days'
  order by (l.lead_id like 'trk-%'), l.created_at desc
  limit 1;

  if lid is null then
    lid := 'trk-' || pn || '-' || to_char(now() at time zone 'UTC', 'YYYYMMDDHH24MISS');
    insert into ha_leads (lead_id, created_at, updated_at, name, phone, service, channel, source,
      utm_source, utm_medium, utm_campaign, utm_term, gclid, ref, status, raw, visitor_id)
    values (lid, now(), now(), coalesce(nm, vr.name), ph, svc,
      case when ev = 'form_submit' then 'website form' else 'website (phone typed)' end,
      case when vr.gclid is not null or coalesce(vr.ref, '') like 'G-%'
                or lower(coalesce(vr.utm_source, '')) in ('google', 'adwords', 'gads') then 'google'
           when lower(coalesce(vr.utm_source, '')) in ('facebook', 'instagram', 'meta', 'fb', 'ig') then 'meta'
           when coalesce(vr.referrer, '') ~* '(google|bing|yahoo|duckduckgo)\.' then 'organic'
           when coalesce(vr.referrer, '') ~* '(facebook|instagram|tiktok|t\.co|twitter|snapchat)' then 'social'
           else 'website' end,
      vr.utm_source, vr.utm_medium, vr.utm_campaign, vr.utm_term, vr.gclid, vr.ref, 'new',
      jsonb_build_object('tracked', true, 'page', pg, 'landing_page', vr.landing_page, 'referrer', vr.referrer),
      vid);
  else
    update ha_leads l set
      visitor_id   = coalesce(l.visitor_id, vid),
      name         = coalesce(l.name, nm),
      service      = coalesce(l.service, svc),
      gclid        = coalesce(l.gclid, vr.gclid),
      ref          = coalesce(l.ref, vr.ref),
      utm_source   = coalesce(l.utm_source, vr.utm_source),
      utm_medium   = coalesce(l.utm_medium, vr.utm_medium),
      utm_campaign = coalesce(l.utm_campaign, vr.utm_campaign),
      utm_term     = coalesce(l.utm_term, vr.utm_term),
      source       = case when coalesce(l.source, 'unknown') in ('unknown', 'website') and vr.gclid is not null then 'google' else l.source end,
      channel      = case when ev = 'form_submit' and l.channel = 'website (phone typed)' then 'website form' else l.channel end,
      updated_at   = now()
    where l.lead_id = lid;
  end if;

  update ha_visitors set lead_id = lid where visitor_id = vid;
  return jsonb_build_object('ok', true, 'lead', true);
end $$;
revoke all on function ha_track(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function ha_track(jsonb) from anon, authenticated';
  end if;
end $$;

-- ───────────────────────── Leads view (rebuilt: CRM status + visitor engagement + de-duplication) ─────────────────────────
-- status = the furthest of: the source system's status, the team's CRM status, clinic sessions for the same phone.
-- "lost" set by the team wins unless the clinic already has a confirmed session.
-- A tracking lead ('trk-…') is hidden when the same phone also arrived through another channel within 30 days
-- (its visit data still shows on that other lead, matched by phone).
drop view if exists ha_v_leads;
create view ha_v_leads as
select
  l.lead_id, l.created_at, l.updated_at, l.name, l.phone, l.service, l.branch, l.channel, l.source,
  coalesce(l.utm_source, v.utm_source) as utm_source, coalesce(l.utm_medium, v.utm_medium) as utm_medium,
  coalesce(l.utm_campaign, v.utm_campaign) as utm_campaign, coalesce(l.utm_term, v.utm_term) as utm_term,
  coalesce(l.gclid, v.gclid) as gclid, coalesce(l.ref, v.ref) as ref, l.raw,
  case r.rank
    when 5 then 'paid' when 4 then 'showed' when 3 then 'booked' when 2 then 'qualified' when 1 then 'contacted'
    when 0 then 'new' when -1 then 'lost' else l.status end as status,
  r.rank as status_rank,
  coalesce(l.value, s.paid_value) as value,
  s.sessions_booked, s.sessions_done,
  case when c.gclid is not null or l.ad_campaign_id is not null then 'google'
       when coalesce(l.source, 'unknown') in ('unknown', 'website') and v.gclid is not null then 'google'
       when coalesce(l.source, 'unknown') in ('unknown', 'website')
            and lower(coalesce(v.utm_source, '')) in ('facebook', 'instagram', 'meta', 'fb', 'ig') then 'meta'
       else coalesce(l.source, 'unknown') end as source_eff,
  coalesce(c.campaign_name, ic.campaign_name) as ad_campaign,
  coalesce(c.ad_group_name, ig.ad_group_name) as ad_group,
  c.keyword as ad_keyword, c.match_type as ad_match_type,
  l.crm_status, l.crm_note, l.contacted_at, l.next_follow_up,
  v.visitor_id, v.visits, v.pageviews, v.wa_clicks, v.call_clicks, v.form_submits,
  v.first_seen, v.last_seen, v.landing_page, v.last_page, v.device
from ha_leads l
left join lateral (
  select x.* from ha_visitors x
  where x.lead_id = l.lead_id or (x.phone_norm is not null and x.phone_norm = ha_norm_phone(l.phone))
  order by (x.lead_id = l.lead_id) desc nulls last, x.last_seen desc
  limit 1
) v on true
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
  where c.gclid = coalesce(l.gclid, v.gclid)
     or (coalesce(l.gclid, v.gclid) is null and coalesce(l.ref, v.ref) like 'G-%' and right(c.gclid, 8) = substr(coalesce(l.ref, v.ref), 3))
  order by (c.gclid = coalesce(l.gclid, v.gclid)) desc nulls last, c.date desc
  limit 1
) c on true
left join lateral (
  select d.campaign_name from ha_campaign_daily d where d.campaign_id = l.ad_campaign_id order by d.date desc limit 1
) ic on true
left join lateral (
  select a.ad_group_name from ha_adgroup_daily a where a.ad_group_id = l.ad_group_id order by a.date desc limit 1
) ig on true
cross join lateral (
  select case
    when lower(coalesce(l.crm_status, '')) = 'lost' and coalesce(s.rank, -9) < 3 then -1
    else greatest(ha_status_rank(l.status),
                  case when nullif(l.crm_status, '') is not null then ha_status_rank(l.crm_status) else -9 end,
                  coalesce(s.rank, -9))
  end as rank
) r
where not (
  l.lead_id like 'trk-%' and exists (
    select 1 from ha_leads o
    where o.lead_id not like 'trk-%'
      and ha_norm_phone(o.phone) = ha_norm_phone(l.phone)
      and o.created_at between l.created_at - interval '30 days' and l.created_at + interval '30 days'
  )
);

alter view ha_v_leads set (security_invoker = true);
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on ha_v_leads from anon, authenticated';
  end if;
end $$;

-- ───────────────────────── Read functions for the new tabs ─────────────────────────
-- Leads for the CRM: everything created in the range, plus the open pipeline of the last 45 days and any
-- follow-up that is due, so the "what to do now" list never misses a lead because of the date filter.
create or replace function ha_dash_crm_leads(d_from date, d_to date)
returns table (lead_id text, created_at timestamptz, in_range boolean, name text, phone text, service text, channel text,
  source text, status text, status_rank int, value numeric, sessions_booked bigint, sessions_done bigint,
  ad_campaign text, ad_group text, ad_keyword text, crm_status text, crm_note text, contacted_at timestamptz,
  next_follow_up timestamptz, visits int, pageviews int, wa_clicks int, call_clicks int, form_submits int,
  first_seen timestamptz, last_seen timestamptz, landing_page text, device text)
language sql stable as $$
  select lead_id, created_at, created_at::date between d_from and d_to, name, phone, service, channel,
    source_eff, status, status_rank, value, sessions_booked, sessions_done,
    ad_campaign, ad_group, ad_keyword, crm_status, crm_note, contacted_at,
    next_follow_up, visits, pageviews, wa_clicks, call_clicks, form_submits,
    first_seen, last_seen, landing_page, device
  from ha_v_leads
  where created_at::date between d_from and d_to
     or (status_rank between 0 and 2 and created_at > now() - interval '45 days')
     or (status_rank between 0 and 2 and next_follow_up < now() + interval '1 day')
  order by created_at desc
  limit 3000
$$;

-- Per service over the 180 days up to d_to: the yardstick for lead scoring and "best service".
create or replace function ha_dash_service_stats(d_from date, d_to date)
returns table (service text, leads bigint, contacted bigint, booked bigint, paid bigint, revenue numeric)
language sql stable as $$
  select coalesce(nullif(service, ''), '(not set)'), count(*),
    count(*) filter (where status_rank >= 1), count(*) filter (where status_rank >= 3),
    count(*) filter (where status_rank >= 5), coalesce(sum(value) filter (where status_rank >= 5), 0)
  from ha_v_leads where created_at::date between d_to - 180 and d_to
  group by 1 order by 2 desc
$$;

-- Website tracking headline numbers
create or replace function ha_dash_tracking(d_from date, d_to date)
returns table (visitors bigint, sessions bigint, pageviews bigint, wa_clicks bigint, call_clicks bigint,
  form_submits bigint, phone_captures bigint, ad_visitors bigint)
language sql stable as $$
  select count(distinct e.visitor_id), count(distinct e.session_id),
    count(*) filter (where e.event = 'pageview'), count(*) filter (where e.event = 'wa_click'),
    count(*) filter (where e.event = 'call_click'), count(*) filter (where e.event = 'form_submit'),
    count(distinct e.visitor_id) filter (where e.event = 'phone'),
    count(distinct e.visitor_id) filter (where v.gclid is not null)
  from ha_events e left join ha_visitors v on v.visitor_id = e.visitor_id
  where (e.ts at time zone 'Africa/Cairo')::date between d_from and d_to
$$;

create or replace function ha_dash_tracking_daily(d_from date, d_to date)
returns table (date date, visitors bigint, phone_captures bigint, wa_clicks bigint)
language sql stable as $$
  with days as (select generate_series(d_from, d_to, interval '1 day')::date d),
  e as (
    select (ts at time zone 'Africa/Cairo')::date d, count(distinct visitor_id) visitors,
      count(distinct visitor_id) filter (where event = 'phone') phones,
      count(*) filter (where event = 'wa_click') wa
    from ha_events where (ts at time zone 'Africa/Cairo')::date between d_from and d_to group by 1
  )
  select days.d, coalesce(e.visitors, 0), coalesce(e.phones, 0), coalesce(e.wa, 0)
  from days left join e on e.d = days.d order by days.d
$$;

-- Landing pages: which entry page turns sessions into phone numbers / WhatsApp chats
create or replace function ha_dash_landing_pages(d_from date, d_to date)
returns table (landing_page text, sessions bigint, visitors bigint, phone_leads bigint, wa_sessions bigint,
  call_sessions bigint, form_sessions bigint, avg_pages numeric)
language sql stable as $$
  with s as (
    select session_id, min(visitor_id) visitor_id,
      (array_agg(page order by ts) filter (where event = 'pageview'))[1] landing,
      bool_or(event = 'phone') phone, bool_or(event = 'wa_click') wa,
      bool_or(event = 'call_click') call, bool_or(event = 'form_submit') form,
      count(*) filter (where event = 'pageview') pv
    from ha_events
    where (ts at time zone 'Africa/Cairo')::date between d_from and d_to and session_id is not null
    group by session_id
  )
  select coalesce(landing, '(unknown)'), count(*), count(distinct visitor_id),
    count(*) filter (where phone), count(*) filter (where wa), count(*) filter (where call),
    count(*) filter (where form), round(avg(pv), 1)
  from s group by 1 order by 2 desc limit 200
$$;

-- Where the visitors come from
create or replace function ha_dash_traffic_sources(d_from date, d_to date)
returns table (source text, visitors bigint, phone_leads bigint, wa_visitors bigint, call_visitors bigint)
language sql stable as $$
  with vis as (
    select distinct e.visitor_id from ha_events e
    where (e.ts at time zone 'Africa/Cairo')::date between d_from and d_to
  )
  select case
      when v.gclid is not null or coalesce(v.ref, '') like 'G-%' or lower(coalesce(v.utm_source, '')) in ('google', 'adwords', 'gads') then 'Google Ads'
      when lower(coalesce(v.utm_source, '')) in ('facebook', 'instagram', 'meta', 'fb', 'ig') then 'Meta Ads'
      when v.utm_source is not null then 'Other campaign (' || v.utm_source || ')'
      when coalesce(v.referrer, '') ~* '(google|bing|yahoo|duckduckgo)\.' then 'Organic search'
      when coalesce(v.referrer, '') ~* '(facebook|instagram|tiktok|t\.co|twitter|snapchat)' then 'Social (organic)'
      when coalesce(v.referrer, '') <> '' then 'Referral'
      else 'Direct' end as src,
    count(*), count(*) filter (where v.phone_norm is not null),
    count(*) filter (where v.wa_clicks > 0), count(*) filter (where v.call_clicks > 0)
  from vis join ha_visitors v on v.visitor_id = vis.visitor_id
  group by 1 order by 2 desc
$$;

-- Only the server may call these
do $$
declare f text;
begin
  foreach f in array array['ha_dash_crm_leads', 'ha_dash_service_stats', 'ha_dash_tracking', 'ha_dash_tracking_daily',
    'ha_dash_landing_pages', 'ha_dash_traffic_sources'] loop
    execute format('revoke all on function %I(date, date) from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %I(date, date) from anon, authenticated', f);
      execute format('grant execute on function %I(date, date) to service_role', f);
    end if;
  end loop;
end $$;

-- Optional housekeeping: keep 12 months of raw events (visitor totals are kept forever).
--   delete from ha_events where ts < now() - interval '12 months';
