create table if not exists public.storage_cleanup_queue (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  storage_asset_id uuid references public.storage_assets(id) on delete set null,
  storage_bucket text not null,
  storage_path text not null,
  requested_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  last_error text,
  unique (storage_bucket, storage_path)
);

create index if not exists storage_cleanup_queue_owner_requested_idx
  on public.storage_cleanup_queue (owner_user_id, requested_at);

create index if not exists storage_cleanup_queue_asset_idx
  on public.storage_cleanup_queue (storage_asset_id)
  where storage_asset_id is not null;

alter table public.storage_cleanup_queue enable row level security;
revoke all on table public.storage_cleanup_queue from anon, authenticated;
grant all on table public.storage_cleanup_queue to service_role;

comment on table public.storage_cleanup_queue is
  'Durable outbox for Storage API deletion after the final database reference is removed.';
