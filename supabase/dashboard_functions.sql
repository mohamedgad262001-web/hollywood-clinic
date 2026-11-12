-- Hollywood dashboard — read functions (called by the dashboard server with the service role key).
-- Run after schema.sql. Safe to re-run.

-- Headline numbers
create or replace function ha_dash_kpis(d_from date, d_to date)
returns table (cost numeric, clicks bigint, impressions bigint, ads_conversions numeric,
  leads bigint, google_leads bigint, qualified bigint, booked bigint, showed bigint, paid bigint, revenue numeric)
language sql stable as $$
  with a as (
    select sum(cost) cost, sum(clicks)::bigint clicks, sum(impressions)::bigint impressions, sum(conversions) conv
    from ha_campaign_daily where date between d_from and d_to
  ), l as (
    select count(*) leads,
      count(*) filter (where source_eff = 'google') google_leads,
      count(*) filter (where source_eff = 'google' and status_rank >= 2) qualified,
      count(*) filter (where source_eff = 'google' and status_rank >= 3) booked,
      count(*) filter (where source_eff = 'google' and status_rank >= 4) showed,
      count(*) filter (where source_eff = 'google' and status_rank >= 5) paid,
      sum(value) filter (where source_eff = 'google' and status_rank >= 5) revenue
    from ha_v_leads where created_at::date between d_from and d_to
  )
  select coalesce(a.cost,0), coalesce(a.clicks,0), coalesce(a.impressions,0), coalesce(a.conv,0),
    l.leads, l.google_leads, l.qualified, l.booked, l.showed, l.paid, coalesce(l.revenue,0)
  from a, l
$$;

-- Day by day: spend vs real leads
create or replace function ha_dash_daily(d_from date, d_to date)
returns table (date date, cost numeric, clicks bigint, ads_conversions numeric, google_leads bigint, qualified bigint)
language sql stable as $$
  with days as (select generate_series(d_from, d_to, interval '1 day')::date d),
  a as (select date, sum(cost) cost, sum(clicks)::bigint clicks, sum(conversions) conv
        from ha_campaign_daily where date between d_from and d_to group by date),
  l as (select created_at::date d, count(*) leads, count(*) filter (where status_rank >= 2) q
        from ha_v_leads where source_eff = 'google' and created_at::date between d_from and d_to group by 1)
  select days.d, coalesce(a.cost,0), coalesce(a.clicks,0), coalesce(a.conv,0), coalesce(l.leads,0), coalesce(l.q,0)
  from days left join a on a.date = days.d left join l on l.d = days.d
  order by days.d
$$;

-- Per campaign
create or replace function ha_dash_campaigns(d_from date, d_to date)
returns table (campaign_id bigint, campaign_name text, status text, bidding text, budget numeric,
  impressions bigint, clicks bigint, cost numeric, ads_conversions numeric, search_is numeric,
  leads bigint, qualified bigint, booked bigint, paid bigint, revenue numeric)
language sql stable as $$
  with a as (
    select campaign_id, sum(impressions)::bigint impressions, sum(clicks)::bigint clicks, sum(cost) cost,
      sum(conversions) conv,
      sum(search_is * impressions) / nullif(sum(impressions) filter (where search_is is not null), 0) search_is
    from ha_campaign_daily where date between d_from and d_to group by campaign_id
  ), latest as (
    select distinct on (campaign_id) campaign_id, campaign_name, campaign_status, bidding, budget
    from ha_campaign_daily order by campaign_id, date desc
  ), l as (
    select ad_campaign, count(*) leads, count(*) filter (where status_rank >= 2) q,
      count(*) filter (where status_rank >= 3) b, count(*) filter (where status_rank >= 5) p,
      sum(value) filter (where status_rank >= 5) rev
    from ha_v_leads where created_at::date between d_from and d_to and ad_campaign is not null group by 1
  )
  select a.campaign_id, latest.campaign_name, latest.campaign_status, latest.bidding, latest.budget,
    a.impressions, a.clicks, a.cost, a.conv, a.search_is,
    coalesce(l.leads,0), coalesce(l.q,0), coalesce(l.b,0), coalesce(l.p,0), coalesce(l.rev,0)
  from a join latest using (campaign_id) left join l on l.ad_campaign = latest.campaign_name
  order by a.cost desc
$$;

-- Per ad group
create or replace function ha_dash_adgroups(d_from date, d_to date)
returns table (ad_group_id bigint, ad_group_name text, campaign_name text, status text,
  impressions bigint, clicks bigint, cost numeric, ads_conversions numeric,
  leads bigint, qualified bigint, booked bigint, paid bigint)
language sql stable as $$
  with a as (
    select ad_group_id, sum(impressions)::bigint impressions, sum(clicks)::bigint clicks, sum(cost) cost, sum(conversions) conv
    from ha_adgroup_daily where date between d_from and d_to group by ad_group_id
  ), latest as (
    select distinct on (ad_group_id) ad_group_id, ad_group_name, campaign_name, ad_group_status
    from ha_adgroup_daily order by ad_group_id, date desc
  ), l as (
    select ad_campaign, ad_group, count(*) leads, count(*) filter (where status_rank >= 2) q,
      count(*) filter (where status_rank >= 3) b, count(*) filter (where status_rank >= 5) p
    from ha_v_leads where created_at::date between d_from and d_to and ad_group is not null group by 1, 2
  )
  select a.ad_group_id, latest.ad_group_name, latest.campaign_name, latest.ad_group_status,
    a.impressions, a.clicks, a.cost, a.conv,
    coalesce(l.leads,0), coalesce(l.q,0), coalesce(l.b,0), coalesce(l.p,0)
  from a join latest using (ad_group_id)
  left join l on l.ad_group = latest.ad_group_name and l.ad_campaign = latest.campaign_name
  order by a.cost desc
$$;

-- Per keyword
create or replace function ha_dash_keywords(d_from date, d_to date)
returns table (keyword text, match_type text, ad_group_name text, campaign_name text, status text, quality_score int,
  impressions bigint, clicks bigint, cost numeric, ads_conversions numeric,
  leads bigint, qualified bigint, booked bigint, paid bigint)
language sql stable as $$
  with a as (
    select ad_group_id, criterion_id, sum(impressions)::bigint impressions, sum(clicks)::bigint clicks,
      sum(cost) cost, sum(conversions) conv
    from ha_keyword_daily where date between d_from and d_to group by 1, 2
  ), latest as (
    select distinct on (ad_group_id, criterion_id) ad_group_id, criterion_id, keyword, match_type, status,
      quality_score, ad_group_name, campaign_name
    from ha_keyword_daily order by ad_group_id, criterion_id, date desc
  ), l as (
    select ad_group, ad_keyword, count(*) leads, count(*) filter (where status_rank >= 2) q,
      count(*) filter (where status_rank >= 3) b, count(*) filter (where status_rank >= 5) p
    from ha_v_leads where created_at::date between d_from and d_to and ad_keyword is not null group by 1, 2
  )
  select latest.keyword, latest.match_type, latest.ad_group_name, latest.campaign_name, latest.status,
    latest.quality_score, a.impressions, a.clicks, a.cost, a.conv,
    coalesce(l.leads,0), coalesce(l.q,0), coalesce(l.b,0), coalesce(l.p,0)
  from a join latest using (ad_group_id, criterion_id)
  left join l on l.ad_group = latest.ad_group_name and l.ad_keyword = latest.keyword
  where a.impressions > 0 or coalesce(l.leads,0) > 0
  order by a.cost desc
$$;

-- Search terms (top 500 by cost)
create or replace function ha_dash_search_terms(d_from date, d_to date)
returns table (search_term text, keyword text, ad_group_name text, campaign_name text,
  impressions bigint, clicks bigint, cost numeric, ads_conversions numeric)
language sql stable as $$
  select search_term, max(keyword), max(ad_group_name), max(campaign_name),
    sum(impressions)::bigint, sum(clicks)::bigint, sum(cost), sum(conversions)
  from ha_search_term_daily where date between d_from and d_to
  group by search_term, ad_group_id
  order by sum(cost) desc
  limit 500
$$;

-- What Google counts as a conversion, by action
create or replace function ha_dash_conversion_actions(d_from date, d_to date)
returns table (conversion_action text, conversions numeric, conv_value numeric)
language sql stable as $$
  select conversion_action, sum(conversions), sum(conv_value)
  from ha_conversion_action_daily where date between d_from and d_to
  group by 1 order by 2 desc
$$;

-- Leads by source and service
create or replace function ha_dash_lead_sources(d_from date, d_to date)
returns table (source text, service text, leads bigint, qualified bigint, booked bigint, paid bigint, revenue numeric)
language sql stable as $$
  select source_eff, coalesce(nullif(service, ''), '(not set)'), count(*),
    count(*) filter (where status_rank >= 2), count(*) filter (where status_rank >= 3),
    count(*) filter (where status_rank >= 5), coalesce(sum(value) filter (where status_rank >= 5), 0)
  from ha_v_leads where created_at::date between d_from and d_to
  group by 1, 2 order by 3 desc
$$;

-- Latest leads
create or replace function ha_dash_recent_leads(d_from date, d_to date)
returns table (lead_id text, created_at timestamptz, name text, phone text, service text, channel text,
  source text, status text, value numeric, ad_campaign text, ad_group text, ad_keyword text)
language sql stable as $$
  select lead_id, created_at, name, phone, service, channel, source_eff, status, value, ad_campaign, ad_group, ad_keyword
  from ha_v_leads where created_at::date between d_from and d_to
  order by created_at desc limit 200
$$;

-- Only the server (service role) may call these
do $$
declare f text;
begin
  foreach f in array array['ha_dash_kpis','ha_dash_daily','ha_dash_campaigns','ha_dash_adgroups','ha_dash_keywords',
    'ha_dash_search_terms','ha_dash_conversion_actions','ha_dash_lead_sources','ha_dash_recent_leads'] loop
    execute format('revoke all on function %I(date, date) from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %I(date, date) from anon, authenticated', f);
      execute format('grant execute on function %I(date, date) to service_role', f);
    end if;
  end loop;
end $$;
