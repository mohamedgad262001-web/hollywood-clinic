-- Hollywood — copy website leads (bookings + contact_messages) into the dashboard's ha_leads table.
-- Use this INSTEAD of the n8n leads workflow when the website tables live in the SAME Supabase project.
-- Run after schema.sql. Safe to re-run. It never changes the website tables' data.

-- 1. Let the website store where each lead came from (filled by lead-source-capture.js)
alter table bookings
  add column if not exists gclid text, add column if not exists utm_source text, add column if not exists utm_medium text,
  add column if not exists utm_campaign text, add column if not exists utm_term text, add column if not exists ref text,
  add column if not exists landing_page text;
alter table contact_messages
  add column if not exists gclid text, add column if not exists utm_source text, add column if not exists utm_medium text,
  add column if not exists utm_campaign text, add column if not exists utm_term text, add column if not exists ref text,
  add column if not exists landing_page text;

-- 2. Map a website status to the dashboard ladder: new → contacted → qualified → booked → showed → paid / lost
create or replace function ha_map_status(s text) returns text language sql immutable as $$
  select case
    when s is null or s = '' then 'new'
    when lower(s) ~ '(paid|invoice|دفع)' then 'paid'
    when lower(s) ~ '(done|complete|attended|showed|visited|حضر|تم)' then 'showed'
    when lower(s) ~ '(confirm|book|scheduled|appointment|حجز|مؤكد)' then 'booked'
    when lower(s) ~ '(qualif|interest|مهتم)' then 'qualified'
    when lower(s) ~ '(contact|called|replied|follow|تواصل)' then 'contacted'
    when lower(s) ~ '(cancel|lost|spam|no.?show|reject|ملغي|الغاء)' then 'lost'
    else 'new' end
$$;

-- 3. Upsert one website row (as jsonb, so it works whatever extra columns the tables have)
create or replace function ha_upsert_website_lead(r jsonb, kind text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into ha_leads (lead_id, created_at, updated_at, name, phone, service, channel, source,
    utm_source, utm_medium, utm_campaign, utm_term, gclid, ref, status, raw)
  values (
    kind || '-' || (r->>'id'),
    coalesce((r->>'created_at')::timestamptz, now()), now(),
    r->>'full_name', r->>'phone',
    case when kind = 'booking' then r->>'treatment' else 'contact message' end,
    case when kind = 'booking' then 'booking form' else 'contact form' end,
    case when coalesce(r->>'gclid', '') <> '' or coalesce(r->>'ref', '') like 'G-%'
              or lower(coalesce(r->>'utm_source', '')) in ('google', 'adwords', 'gads') then 'google'
         when lower(coalesce(r->>'utm_source', '')) in ('facebook', 'instagram', 'meta', 'fb', 'ig') then 'meta'
         else 'unknown' end,
    nullif(r->>'utm_source', ''), nullif(r->>'utm_medium', ''), nullif(r->>'utm_campaign', ''), nullif(r->>'utm_term', ''),
    nullif(r->>'gclid', ''), nullif(r->>'ref', ''),
    ha_map_status(r->>'status'),
    r
  )
  on conflict (lead_id) do update set
    updated_at = now(), name = excluded.name, phone = excluded.phone, service = excluded.service,
    source = case when excluded.source = 'unknown' then ha_leads.source else excluded.source end,
    utm_source = coalesce(excluded.utm_source, ha_leads.utm_source), utm_medium = coalesce(excluded.utm_medium, ha_leads.utm_medium),
    utm_campaign = coalesce(excluded.utm_campaign, ha_leads.utm_campaign), utm_term = coalesce(excluded.utm_term, ha_leads.utm_term),
    gclid = coalesce(excluded.gclid, ha_leads.gclid), ref = coalesce(excluded.ref, ha_leads.ref),
    -- a status set by the n8n/clinic sync (higher on the ladder) is never pulled back down
    status = case when ha_status_rank(excluded.status) >= ha_status_rank(ha_leads.status) or excluded.status = 'lost'
                  then excluded.status else ha_leads.status end,
    raw = excluded.raw;
end $$;

create or replace function ha_trg_booking() returns trigger language plpgsql security definer set search_path = public as $$
begin perform ha_upsert_website_lead(to_jsonb(new), 'booking'); return new; end $$;

create or replace function ha_trg_contact() returns trigger language plpgsql security definer set search_path = public as $$
begin perform ha_upsert_website_lead(to_jsonb(new), 'contact'); return new; end $$;

drop trigger if exists ha_sync_booking on bookings;
create trigger ha_sync_booking after insert or update on bookings
  for each row execute function ha_trg_booking();

drop trigger if exists ha_sync_contact on contact_messages;
create trigger ha_sync_contact after insert or update on contact_messages
  for each row execute function ha_trg_contact();

revoke all on function ha_upsert_website_lead(jsonb, text) from public;

-- 4. Copy the leads that already exist
select ha_upsert_website_lead(to_jsonb(b), 'booking') from bookings b;
select ha_upsert_website_lead(to_jsonb(c), 'contact') from contact_messages c;

-- Check:  select source, status, count(*) from ha_leads group by 1, 2 order by 3 desc;
