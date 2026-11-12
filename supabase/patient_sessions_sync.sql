-- Hollywood — NO workflow changes needed.
-- Your existing confirmation workflow already saves every confirmed session into chat.patient_sessions
-- (phone, session_record_id, session_date, session_time). This copies those rows into the dashboard,
-- so a lead whose phone gets a confirmed session shows as "booked".
-- Requires: the dashboard tables (schema.sql + clinic_sessions_sync.sql) in the SAME Supabase project as chat.patient_sessions.
-- Safe to re-run. It only reads chat.patient_sessions; it never changes it.

create or replace function ha_trg_patient_session() returns trigger
language plpgsql security definer set search_path = public as $$
declare r jsonb := to_jsonb(new);
begin
  if (r->>'session_record_id') is null then return new; end if;
  insert into ha_sessions (session_record_id, phone_norm, session_date, session_time, status, created_at, last_event, updated_at, raw)
  values (
    (r->>'session_record_id')::bigint,
    ha_norm_phone(r->>'phone'),
    case when r->>'session_date' ~ '^\d{4}-\d{2}-\d{2}' then left(r->>'session_date', 10)::date end,
    r->>'session_time',
    coalesce(r->>'status', 'confirmation sent'),
    coalesce(nullif(r->>'created_at', '')::timestamptz,
      case when r->>'session_date' ~ '^\d{4}-\d{2}-\d{2}' then left(r->>'session_date', 10)::timestamptz end, now()),
    'patient_sessions', now(), r)
  on conflict (session_record_id) do update set
    phone_norm = coalesce(excluded.phone_norm, ha_sessions.phone_norm),
    session_date = coalesce(excluded.session_date, ha_sessions.session_date),
    session_time = coalesce(excluded.session_time, ha_sessions.session_time),
    updated_at = now();
  return new;
end $$;

drop trigger if exists ha_sync_patient_session on chat.patient_sessions;
create trigger ha_sync_patient_session after insert or update on chat.patient_sessions
  for each row execute function ha_trg_patient_session();

-- copy the sessions that already exist
do $$ declare r record; begin
  for r in select * from chat.patient_sessions loop
    insert into ha_sessions (session_record_id, phone_norm, session_date, session_time, status, created_at, last_event, updated_at, raw)
    select (j->>'session_record_id')::bigint, ha_norm_phone(j->>'phone'),
      case when j->>'session_date' ~ '^\d{4}-\d{2}-\d{2}' then left(j->>'session_date', 10)::date end,
      j->>'session_time', coalesce(j->>'status', 'confirmation sent'),
      coalesce(nullif(j->>'created_at', '')::timestamptz,
        case when j->>'session_date' ~ '^\d{4}-\d{2}-\d{2}' then left(j->>'session_date', 10)::timestamptz end, now()),
      'patient_sessions', now(), j
    from (select to_jsonb(r) as j) x
    where j->>'session_record_id' is not null
    on conflict (session_record_id) do nothing;
  end loop;
end $$;

-- Check:  select count(*) from ha_sessions;
