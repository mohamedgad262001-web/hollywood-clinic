-- Hollywood Clinic — Leads + Google Ads dashboard
-- Run once in Supabase → SQL Editor. Safe to re-run.
-- Tables are prefixed ha_ (Hollywood Ads) so they don't clash with anything else in the project.

create extension if not exists pgcrypto;

-- ───────────────────────── Settings (ingest secret) ─────────────────────────
create table if not exists ha_settings (
  key   text primary key,
  value text not null
);
-- Generate a random secret once. Read it with:  select value from ha_settings where key = 'ingest_secret';
insert into ha_settings (key, value)
values ('ingest_secret', encode(gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

-- ───────────────────────── Google Ads data ─────────────────────────
create table if not exists ha_campaign_daily (
  date            date    not null,
  campaign_id     bigint  not null,
  campaign_name   text,
  campaign_status text,
  budget          numeric,          -- daily budget (account currency)
  bidding         text,
  impressions     bigint  default 0,
  clicks          bigint  default 0,
  cost            numeric default 0,
  conversions     numeric default 0,
  conv_value      numeric default 0,
  search_is       numeric,          -- search impression share 0..1 (null when < 10%)
  search_top_is   numeric,
  search_abs_top_is numeric,
  updated_at      timestamptz default now(),
  primary key (date, campaign_id)
);

create table if not exists ha_adgroup_daily (
  date          date   not null,
  ad_group_id   bigint not null,
  ad_group_name text,
  ad_group_status text,
  campaign_id   bigint,
  campaign_name text,
  impressions   bigint  default 0,
  clicks        bigint  default 0,
  cost          numeric default 0,
  conversions   numeric default 0,
  updated_at    timestamptz default now(),
  primary key (date, ad_group_id)
);

create table if not exists ha_keyword_daily (
  date          date   not null,
  ad_group_id   bigint not null,
  criterion_id  bigint not null,
  keyword       text,
  match_type    text,
  status        text,
  quality_score int,
  ad_group_name text,
  campaign_id   bigint,
  campaign_name text,
  impressions   bigint  default 0,
  clicks        bigint  default 0,
  cost          numeric default 0,
  conversions   numeric default 0,
  updated_at    timestamptz default now(),
  primary key (date, ad_group_id, criterion_id)
);

create table if not exists ha_search_term_daily (
  date          date not null,
  search_term   text not null,
  ad_group_id   bigint not null,
  keyword       text,
  ad_group_name text,
  campaign_name text,
  impressions   bigint  default 0,
  clicks        bigint  default 0,
  cost          numeric default 0,
  conversions   numeric default 0,
  updated_at    timestamptz default now(),
  primary key (date, search_term, ad_group_id)
);

create table if not exists ha_conversion_action_daily (
  date            date not null,
  campaign_id     bigint not null,
  conversion_action text not null,
  conversions     numeric default 0,
  conv_value      numeric default 0,
  updated_at      timestamptz default now(),
  primary key (date, campaign_id, conversion_action)
);

-- One row per ad click (from click_view). This is what ties a lead's gclid to a keyword.
create table if not exists ha_clicks (
  gclid         text primary key,
  date          date,
  campaign_id   bigint,
  campaign_name text,
  ad_group_id   bigint,
  ad_group_name text,
  keyword       text,
  match_type    text,
  device        text,
  updated_at    timestamptz default now()
);
create index if not exists ha_clicks_date_idx on ha_clicks (date);
create index if not exists ha_clicks_tail_idx on ha_clicks (right(gclid, 8));

-- ───────────────────────── Leads (from the clinic Leads API) ─────────────────────────
create table if not exists ha_leads (
  lead_id       text primary key,          -- id in the clinic system
  created_at    timestamptz not null,
  updated_at    timestamptz default now(),
  name          text,
  phone         text,
  service       text,                      -- interest / service asked about
  branch        text,
  channel       text,                      -- whatsapp / form / call / walk-in / other
  source        text,                      -- google / meta / organic / referral / unknown (derived if empty)
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  utm_term      text,
  gclid         text,
  ref           text,                      -- short code from the website/WhatsApp link, e.g. G-7f3k2a9x
  status        text default 'new',        -- new, contacted, qualified, booked, showed, paid, lost
  value         numeric,                   -- revenue when paid
  raw           jsonb
);
create index if not exists ha_leads_created_idx on ha_leads (created_at);
create index if not exists ha_leads_gclid_idx   on ha_leads (gclid);
alter table ha_leads add column if not exists ref text;

-- Status ladder so "booked" also counts as qualified, etc.
create or replace function ha_status_rank(s text) returns int language sql immutable as $$
  select case lower(coalesce(s, 'new'))
    when 'new' then 0 when 'contacted' then 1 when 'qualified' then 2
    when 'booked' then 3 when 'showed' then 4 when 'paid' then 5
    when 'lost' then -1 else 0 end
$$;

-- ───────────────────────── Ingest functions (called with the anon key + secret) ─────────────────────────
-- Payload shape: {"secret":"...", "table":"campaign_daily", "rows":[{...}, ...]}
create or replace function ha_ingest_ads(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t text := payload->>'table';
  r jsonb := coalesce(payload->'rows', '[]'::jsonb);
  n int;
begin
  if payload->>'secret' is distinct from (select value from ha_settings where key = 'ingest_secret') then
    raise exception 'bad secret' using errcode = '28000';
  end if;

  if t = 'campaign_daily' then
    insert into ha_campaign_daily as d (date, campaign_id, campaign_name, campaign_status, budget, bidding,
      impressions, clicks, cost, conversions, conv_value, search_is, search_top_is, search_abs_top_is, updated_at)
    select x.date, x.campaign_id, x.campaign_name, x.campaign_status, x.budget, x.bidding,
      coalesce(x.impressions,0), coalesce(x.clicks,0), coalesce(x.cost,0), coalesce(x.conversions,0), coalesce(x.conv_value,0),
      x.search_is, x.search_top_is, x.search_abs_top_is, now()
    from jsonb_to_recordset(r) as x(date date, campaign_id bigint, campaign_name text, campaign_status text, budget numeric,
      bidding text, impressions bigint, clicks bigint, cost numeric, conversions numeric, conv_value numeric,
      search_is numeric, search_top_is numeric, search_abs_top_is numeric)
    on conflict (date, campaign_id) do update set
      campaign_name = excluded.campaign_name, campaign_status = excluded.campaign_status, budget = excluded.budget,
      bidding = excluded.bidding, impressions = excluded.impressions, clicks = excluded.clicks, cost = excluded.cost,
      conversions = excluded.conversions, conv_value = excluded.conv_value, search_is = excluded.search_is,
      search_top_is = excluded.search_top_is, search_abs_top_is = excluded.search_abs_top_is, updated_at = now();

  elsif t = 'adgroup_daily' then
    insert into ha_adgroup_daily (date, ad_group_id, ad_group_name, ad_group_status, campaign_id, campaign_name,
      impressions, clicks, cost, conversions, updated_at)
    select x.date, x.ad_group_id, x.ad_group_name, x.ad_group_status, x.campaign_id, x.campaign_name,
      coalesce(x.impressions,0), coalesce(x.clicks,0), coalesce(x.cost,0), coalesce(x.conversions,0), now()
    from jsonb_to_recordset(r) as x(date date, ad_group_id bigint, ad_group_name text, ad_group_status text,
      campaign_id bigint, campaign_name text, impressions bigint, clicks bigint, cost numeric, conversions numeric)
    on conflict (date, ad_group_id) do update set
      ad_group_name = excluded.ad_group_name, ad_group_status = excluded.ad_group_status, campaign_id = excluded.campaign_id,
      campaign_name = excluded.campaign_name, impressions = excluded.impressions, clicks = excluded.clicks,
      cost = excluded.cost, conversions = excluded.conversions, updated_at = now();

  elsif t = 'keyword_daily' then
    insert into ha_keyword_daily (date, ad_group_id, criterion_id, keyword, match_type, status, quality_score,
      ad_group_name, campaign_id, campaign_name, impressions, clicks, cost, conversions, updated_at)
    select x.date, x.ad_group_id, x.criterion_id, x.keyword, x.match_type, x.status, x.quality_score,
      x.ad_group_name, x.campaign_id, x.campaign_name,
      coalesce(x.impressions,0), coalesce(x.clicks,0), coalesce(x.cost,0), coalesce(x.conversions,0), now()
    from jsonb_to_recordset(r) as x(date date, ad_group_id bigint, criterion_id bigint, keyword text, match_type text,
      status text, quality_score int, ad_group_name text, campaign_id bigint, campaign_name text,
      impressions bigint, clicks bigint, cost numeric, conversions numeric)
    on conflict (date, ad_group_id, criterion_id) do update set
      keyword = excluded.keyword, match_type = excluded.match_type, status = excluded.status,
      quality_score = excluded.quality_score, ad_group_name = excluded.ad_group_name, campaign_id = excluded.campaign_id,
      campaign_name = excluded.campaign_name, impressions = excluded.impressions, clicks = excluded.clicks,
      cost = excluded.cost, conversions = excluded.conversions, updated_at = now();

  elsif t = 'search_term_daily' then
    insert into ha_search_term_daily (date, search_term, ad_group_id, keyword, ad_group_name, campaign_name,
      impressions, clicks, cost, conversions, updated_at)
    select x.date, x.search_term, x.ad_group_id, max(x.keyword), max(x.ad_group_name), max(x.campaign_name),
      sum(coalesce(x.impressions,0)), sum(coalesce(x.clicks,0)), sum(coalesce(x.cost,0)), sum(coalesce(x.conversions,0)), now()
    from jsonb_to_recordset(r) as x(date date, search_term text, ad_group_id bigint, keyword text, ad_group_name text,
      campaign_name text, impressions bigint, clicks bigint, cost numeric, conversions numeric)
    group by x.date, x.search_term, x.ad_group_id
    on conflict (date, search_term, ad_group_id) do update set
      keyword = excluded.keyword, ad_group_name = excluded.ad_group_name, campaign_name = excluded.campaign_name,
      impressions = excluded.impressions, clicks = excluded.clicks, cost = excluded.cost,
      conversions = excluded.conversions, updated_at = now();

  elsif t = 'conversion_action_daily' then
    insert into ha_conversion_action_daily (date, campaign_id, conversion_action, conversions, conv_value, updated_at)
    select x.date, x.campaign_id, x.conversion_action, sum(coalesce(x.conversions,0)), sum(coalesce(x.conv_value,0)), now()
    from jsonb_to_recordset(r) as x(date date, campaign_id bigint, conversion_action text, conversions numeric, conv_value numeric)
    group by x.date, x.campaign_id, x.conversion_action
    on conflict (date, campaign_id, conversion_action) do update set
      conversions = excluded.conversions, conv_value = excluded.conv_value, updated_at = now();

  elsif t = 'clicks' then
    insert into ha_clicks (gclid, date, campaign_id, campaign_name, ad_group_id, ad_group_name, keyword, match_type, device, updated_at)
    select distinct on (x.gclid) x.gclid, x.date, x.campaign_id, x.campaign_name, x.ad_group_id, x.ad_group_name,
      x.keyword, x.match_type, x.device, now()
    from jsonb_to_recordset(r) as x(gclid text, date date, campaign_id bigint, campaign_name text, ad_group_id bigint,
      ad_group_name text, keyword text, match_type text, device text)
    where x.gclid is not null
    on conflict (gclid) do update set
      date = excluded.date, campaign_id = excluded.campaign_id, campaign_name = excluded.campaign_name,
      ad_group_id = excluded.ad_group_id, ad_group_name = excluded.ad_group_name, keyword = excluded.keyword,
      match_type = excluded.match_type, device = excluded.device, updated_at = now();

  else
    raise exception 'unknown table %', t;
  end if;

  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'table', t, 'rows', n);
end;
$$;

-- Payload shape: {"secret":"...", "rows":[{lead_id, created_at, name, phone, service, ...}]}
create or replace function ha_ingest_leads(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  if payload->>'secret' is distinct from (select value from ha_settings where key = 'ingest_secret') then
    raise exception 'bad secret' using errcode = '28000';
  end if;

  insert into ha_leads (lead_id, created_at, updated_at, name, phone, service, branch, channel, source,
    utm_source, utm_medium, utm_campaign, utm_term, gclid, ref, status, value, raw)
  select x.lead_id, coalesce(x.created_at, now()), now(), x.name, x.phone, x.service, x.branch, x.channel,
    coalesce(nullif(x.source, ''),
      case when nullif(x.gclid, '') is not null or coalesce(x.ref, '') like 'G-%' or lower(coalesce(x.utm_source,'')) in ('google','adwords','gads') then 'google'
           when lower(coalesce(x.utm_source,'')) in ('facebook','instagram','meta','fb','ig') then 'meta'
           else 'unknown' end),
    x.utm_source, x.utm_medium, x.utm_campaign, x.utm_term, nullif(x.gclid, ''),
    coalesce(nullif(x.ref, ''), substring(x.raw::text from '\[ref: ([A-Za-z0-9_-]+)\]')),
    lower(coalesce(nullif(x.status, ''), 'new')), x.value, x.raw
  from jsonb_to_recordset(coalesce(payload->'rows', '[]'::jsonb)) as x(lead_id text, created_at timestamptz, name text,
    phone text, service text, branch text, channel text, source text, utm_source text, utm_medium text,
    utm_campaign text, utm_term text, gclid text, ref text, status text, value numeric, raw jsonb)
  where x.lead_id is not null
  on conflict (lead_id) do update set
    updated_at = now(), name = coalesce(excluded.name, ha_leads.name), phone = coalesce(excluded.phone, ha_leads.phone),
    service = coalesce(excluded.service, ha_leads.service), branch = coalesce(excluded.branch, ha_leads.branch),
    channel = coalesce(excluded.channel, ha_leads.channel),
    source = case when excluded.source = 'unknown' then ha_leads.source else excluded.source end,
    utm_source = coalesce(excluded.utm_source, ha_leads.utm_source), utm_medium = coalesce(excluded.utm_medium, ha_leads.utm_medium),
    utm_campaign = coalesce(excluded.utm_campaign, ha_leads.utm_campaign), utm_term = coalesce(excluded.utm_term, ha_leads.utm_term),
    gclid = coalesce(excluded.gclid, ha_leads.gclid), ref = coalesce(excluded.ref, ha_leads.ref), status = excluded.status,
    value = coalesce(excluded.value, ha_leads.value), raw = coalesce(excluded.raw, ha_leads.raw);

  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'rows', n);
end;
$$;

-- Only the ingest functions are reachable with the anon key; the tables themselves are locked.
alter table ha_settings               enable row level security;
alter table ha_campaign_daily         enable row level security;
alter table ha_adgroup_daily          enable row level security;
alter table ha_keyword_daily          enable row level security;
alter table ha_search_term_daily      enable row level security;
alter table ha_conversion_action_daily enable row level security;
alter table ha_clicks                 enable row level security;
alter table ha_leads                  enable row level security;

revoke all on function ha_ingest_ads(jsonb)   from public;
revoke all on function ha_ingest_leads(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function ha_ingest_ads(jsonb) to anon, authenticated, service_role';
    execute 'grant execute on function ha_ingest_leads(jsonb) to anon, authenticated, service_role';
  end if;
end $$;

-- ───────────────────────── Views the dashboard reads (service role only) ─────────────────────────
-- Each lead joined to the ad click that produced it (via gclid).
drop view if exists ha_v_leads;
create view ha_v_leads as
select l.*,
  ha_status_rank(l.status) as status_rank,
  case when c.gclid is not null then 'google' else coalesce(l.source, 'unknown') end as source_eff,
  c.campaign_name as ad_campaign, c.ad_group_name as ad_group, c.keyword as ad_keyword, c.match_type as ad_match_type
from ha_leads l
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
