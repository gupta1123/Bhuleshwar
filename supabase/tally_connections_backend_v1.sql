create extension if not exists pgcrypto;

create or replace function public.set_packet_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.tally_connections (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'Tally Prime',
  status text not null default 'waiting_for_bridge'
    check (
      status in (
        'not_connected',
        'waiting_for_bridge',
        'bridge_connected',
        'tally_reachable',
        'company_loaded',
        'connection_error'
      )
    ),
  tally_url text not null default 'http://localhost:9000',
  pairing_code_hash text,
  pairing_code_expires_at timestamptz,
  paired_at timestamptz,
  bridge_token_hash text,
  bridge_name text,
  bridge_version text,
  bridge_machine_id text,
  last_heartbeat_at timestamptz,
  last_tested_at timestamptz,
  last_tally_reachable boolean,
  last_company_loaded boolean,
  last_company_name text,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tally_connection_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.tally_connections(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  message text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists tally_connections_owner_status_idx
on public.tally_connections (owner_user_id, status);

create index if not exists tally_connections_owner_updated_idx
on public.tally_connections (owner_user_id, updated_at desc);

create index if not exists tally_connections_pairing_expiry_idx
on public.tally_connections (pairing_code_expires_at)
where pairing_code_hash is not null;

create index if not exists tally_connections_last_heartbeat_idx
on public.tally_connections (last_heartbeat_at desc)
where bridge_token_hash is not null;

create index if not exists tally_connection_events_connection_created_idx
on public.tally_connection_events (connection_id, created_at desc);

create index if not exists tally_connection_events_owner_created_idx
on public.tally_connection_events (owner_user_id, created_at desc);

alter table public.tally_connections enable row level security;
alter table public.tally_connection_events enable row level security;

drop trigger if exists set_tally_connections_updated_at on public.tally_connections;
create trigger set_tally_connections_updated_at
before update on public.tally_connections
for each row
execute function public.set_packet_updated_at();

drop policy if exists "tally_connections_owner_select" on public.tally_connections;
create policy "tally_connections_owner_select"
on public.tally_connections
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "tally_connections_owner_insert" on public.tally_connections;
create policy "tally_connections_owner_insert"
on public.tally_connections
for insert
to authenticated
with check (owner_user_id = auth.uid());

drop policy if exists "tally_connections_owner_update" on public.tally_connections;
create policy "tally_connections_owner_update"
on public.tally_connections
for update
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

drop policy if exists "tally_connections_owner_delete" on public.tally_connections;
create policy "tally_connections_owner_delete"
on public.tally_connections
for delete
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "tally_connection_events_owner_select" on public.tally_connection_events;
create policy "tally_connection_events_owner_select"
on public.tally_connection_events
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "tally_connection_events_owner_insert" on public.tally_connection_events;
create policy "tally_connection_events_owner_insert"
on public.tally_connection_events
for insert
to authenticated
with check (
  owner_user_id = auth.uid()
  and exists (
    select 1
    from public.tally_connections
    where public.tally_connections.id = tally_connection_events.connection_id
      and public.tally_connections.owner_user_id = auth.uid()
  )
);
