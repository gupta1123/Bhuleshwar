-- Prevent overlapping master refreshes for the same connector/company.
-- Apply this migration before deploying the matching API code.

create table if not exists public.tally_master_sync_locks (
  connection_id uuid primary key references public.tally_connections(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  company_name text not null,
  lock_token uuid not null,
  acquired_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null
);

create index if not exists tally_master_sync_locks_expiry_idx
  on public.tally_master_sync_locks (expires_at);

alter table public.tally_master_sync_locks enable row level security;
revoke all on table public.tally_master_sync_locks from anon, authenticated;
grant all on table public.tally_master_sync_locks to service_role;
