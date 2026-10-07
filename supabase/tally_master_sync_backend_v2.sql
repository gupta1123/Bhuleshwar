create table if not exists public.tally_master_sync_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.tally_connections(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'completed'
    check (status in ('completed', 'failed')),
  company_name text,
  bridge_version text,
  totals jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tally_masters (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.tally_connections(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  sync_run_id uuid references public.tally_master_sync_runs(id) on delete set null,
  master_type text not null
    check (
      master_type in (
        'ledger',
        'group',
        'stock_item',
        'unit',
        'voucher_type',
        'gst_ledger',
        'tax_ledger'
      )
    ),
  master_key text not null,
  tally_guid text,
  tally_name text not null,
  parent_name text,
  gstin text,
  hsn_code text,
  unit_name text,
  tax_rate numeric,
  raw_payload jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  last_synced_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (connection_id, master_type, master_key)
);

create table if not exists public.tally_mapping_settings (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.tally_connections(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  mapping_type text not null
    check (
      mapping_type in (
        'supplier_gstin',
        'buyer_gstin',
        'item_hsn',
        'item_description',
        'gst_rate',
        'freight_ledger',
        'round_off_ledger',
        'voucher_type'
      )
    ),
  source_key text not null,
  source_label text not null,
  target_master_type text not null,
  target_master_key text not null,
  target_master_name text not null,
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (connection_id, mapping_type, source_key)
);

create index if not exists tally_master_sync_runs_connection_created_idx
on public.tally_master_sync_runs (connection_id, created_at desc);

create index if not exists tally_masters_connection_type_name_idx
on public.tally_masters (connection_id, master_type, tally_name);

create index if not exists tally_masters_connection_type_active_idx
on public.tally_masters (connection_id, master_type, is_active);

create index if not exists tally_masters_owner_updated_idx
on public.tally_masters (owner_user_id, updated_at desc);

create index if not exists tally_mapping_settings_connection_type_idx
on public.tally_mapping_settings (connection_id, mapping_type, updated_at desc);

alter table public.tally_master_sync_runs enable row level security;
alter table public.tally_masters enable row level security;
alter table public.tally_mapping_settings enable row level security;

drop trigger if exists set_tally_masters_updated_at on public.tally_masters;
create trigger set_tally_masters_updated_at
before update on public.tally_masters
for each row
execute function public.set_packet_updated_at();

drop trigger if exists set_tally_mapping_settings_updated_at on public.tally_mapping_settings;
create trigger set_tally_mapping_settings_updated_at
before update on public.tally_mapping_settings
for each row
execute function public.set_packet_updated_at();

drop policy if exists "tally_master_sync_runs_owner_select" on public.tally_master_sync_runs;
create policy "tally_master_sync_runs_owner_select"
on public.tally_master_sync_runs
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "tally_masters_owner_select" on public.tally_masters;
create policy "tally_masters_owner_select"
on public.tally_masters
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "tally_mapping_settings_owner_select" on public.tally_mapping_settings;
create policy "tally_mapping_settings_owner_select"
on public.tally_mapping_settings
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "tally_mapping_settings_owner_insert" on public.tally_mapping_settings;
create policy "tally_mapping_settings_owner_insert"
on public.tally_mapping_settings
for insert
to authenticated
with check (
  owner_user_id = auth.uid()
  and exists (
    select 1
    from public.tally_connections
    where public.tally_connections.id = tally_mapping_settings.connection_id
      and public.tally_connections.owner_user_id = auth.uid()
  )
);

drop policy if exists "tally_mapping_settings_owner_update" on public.tally_mapping_settings;
create policy "tally_mapping_settings_owner_update"
on public.tally_mapping_settings
for update
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

drop policy if exists "tally_mapping_settings_owner_delete" on public.tally_mapping_settings;
create policy "tally_mapping_settings_owner_delete"
on public.tally_mapping_settings
for delete
to authenticated
using (owner_user_id = auth.uid());
