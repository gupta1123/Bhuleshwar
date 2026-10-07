create table if not exists public.tally_bridge_commands (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.tally_connections(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  command_type text not null
    check (
      command_type in (
        'alter_ledger'
      )
    ),
  status text not null default 'queued'
    check (
      status in (
        'queued',
        'claimed',
        'succeeded',
        'failed',
        'canceled'
      )
    ),
  priority integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  available_at timestamptz not null default timezone('utc', now()),
  claimed_at timestamptz,
  completed_at timestamptz,
  bridge_version text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists tally_bridge_commands_connection_status_idx
on public.tally_bridge_commands (connection_id, status, available_at, created_at);

create index if not exists tally_bridge_commands_owner_created_idx
on public.tally_bridge_commands (owner_user_id, created_at desc);

alter table public.tally_bridge_commands enable row level security;

drop trigger if exists set_tally_bridge_commands_updated_at on public.tally_bridge_commands;
create trigger set_tally_bridge_commands_updated_at
before update on public.tally_bridge_commands
for each row
execute function public.set_packet_updated_at();

drop policy if exists "tally_bridge_commands_owner_select" on public.tally_bridge_commands;
create policy "tally_bridge_commands_owner_select"
on public.tally_bridge_commands
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "tally_bridge_commands_owner_insert" on public.tally_bridge_commands;
create policy "tally_bridge_commands_owner_insert"
on public.tally_bridge_commands
for insert
to authenticated
with check (
  owner_user_id = auth.uid()
  and exists (
    select 1
    from public.tally_connections
    where public.tally_connections.id = tally_bridge_commands.connection_id
      and public.tally_connections.owner_user_id = auth.uid()
  )
);

drop policy if exists "tally_bridge_commands_owner_update_cancel" on public.tally_bridge_commands;
create policy "tally_bridge_commands_owner_update_cancel"
on public.tally_bridge_commands
for update
to authenticated
using (owner_user_id = auth.uid())
with check (
  owner_user_id = auth.uid()
  and status in ('queued', 'canceled')
);
