-- Kalika Tally connection/company read performance and heartbeat snapshot.
-- Apply manually in Supabase SQL Editor.

alter table public.tally_connections
  add column if not exists last_companies_snapshot jsonb not null default '[]'::jsonb;

create index if not exists
  tally_masters_connection_company_type_active_name_idx
on public.tally_masters (
  connection_id,
  company_name,
  master_type,
  is_active,
  tally_name
);

create index if not exists
  tally_connections_owner_active_updated_idx
on public.tally_connections (owner_user_id, updated_at desc)
where revoked_at is null;
