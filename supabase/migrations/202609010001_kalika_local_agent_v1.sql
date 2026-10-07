-- Kalika Local Agent v1 cloud coordination metadata.
-- This migration intentionally stores cache identity and health only. Accounting
-- rows, open bills, parsed documents and vectors remain on the client machine.

do $$
begin
  if to_regclass('public.tally_connections') is not null then
    alter table public.tally_connections
      add column if not exists organization_id text,
      add column if not exists agent_protocol_version integer not null default 0,
      add column if not exists agent_version text,
      add column if not exists agent_capabilities jsonb not null default '[]'::jsonb,
      add column if not exists agent_status jsonb not null default '{}'::jsonb,
      add column if not exists agent_last_seen_at timestamptz,
      add column if not exists tdl_version integer,
      add column if not exists local_schema_version integer;

    update public.tally_connections
       set organization_id = coalesce(nullif(organization_id, ''), owner_user_id::text)
     where organization_id is null or organization_id = '';

    create index if not exists tally_connections_agent_identity_idx
      on public.tally_connections
      (owner_user_id, organization_id, installation_id, session_generation, updated_at desc)
      where revoked_at is null;
  end if;
end $$;

do $$
begin
  if to_regclass('public.tally_bridge_commands') is not null then
    alter table public.tally_bridge_commands
      add column if not exists organization_id text,
      add column if not exists installation_id text,
      add column if not exists session_generation bigint,
      add column if not exists company_guid text,
      add column if not exists company_name text,
      add column if not exists financial_year text,
      add column if not exists protocol_version integer not null default 0,
      add column if not exists job_class text,
      add column if not exists deadline_at timestamptz,
      add column if not exists compact_progress jsonb not null default '{}'::jsonb,
      add column if not exists agent_receipt text,
      add column if not exists external_result_reference text;

    if to_regclass('public.tally_connections') is not null then
      update public.tally_bridge_commands c
         set organization_id = coalesce(c.organization_id, x.organization_id, c.owner_user_id::text),
             installation_id = coalesce(c.installation_id, x.installation_id),
             session_generation = coalesce(c.session_generation, x.session_generation)
        from public.tally_connections x
       where x.id = c.connection_id
         and (c.organization_id is null or c.installation_id is null or c.session_generation is null);
    end if;

    create index if not exists tally_bridge_commands_agent_claim_idx
      on public.tally_bridge_commands
      (connection_id, installation_id, session_generation, status, priority desc, available_at, created_at);
    create index if not exists tally_bridge_commands_agent_dataset_idx
      on public.tally_bridge_commands
      (owner_user_id, organization_id, connection_id, company_guid, financial_year, created_at desc);

    alter table public.tally_bridge_commands
      drop constraint if exists tally_bridge_commands_command_type_check;
    alter table public.tally_bridge_commands
      add constraint tally_bridge_commands_command_type_check
      check (command_type in (
        'alter_ledger', 'create_ledger', 'fetch_bank_ledgers', 'fetch_purchase_masters',
        'sync_masters', 'post_bank_voucher', 'post_purchase_voucher',
        'fetch_customer_open_bills', 'create_debit_note', 'export_debit_note_pdf',
        'verify_bank_transaction', 'create_purchase_voucher', 'agent_sync_dataset',
        'agent_reconcile_dataset', 'agent_parse_document', 'agent_vector_suggest',
        'agent_cache_maintenance', 'agent_clear_cache', 'agent_update_settings',
        'agent_rebuild_cache', 'agent_diagnostics', 'agent_query_open_bills',
        'agent_query_workflow_vouchers', 'agent_voucher_identity'
      ));
  end if;
end $$;

create or replace function public.populate_tally_agent_command_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  connection_row public.tally_connections%rowtype;
  company_row jsonb;
begin
  select * into connection_row from public.tally_connections where id = new.connection_id;
  if not found then return new; end if;
  new.organization_id := coalesce(new.organization_id, connection_row.organization_id, connection_row.owner_user_id::text);
  new.installation_id := coalesce(new.installation_id, connection_row.installation_id);
  new.session_generation := coalesce(new.session_generation, connection_row.session_generation);
  new.protocol_version := greatest(coalesce(new.protocol_version, 0), coalesce(connection_row.agent_protocol_version, 0));
  new.company_name := coalesce(new.company_name, nullif(new.payload->>'companyName', ''), connection_row.last_company_name);
  new.company_guid := coalesce(new.company_guid, nullif(new.payload->>'companyGuid', ''));
  new.financial_year := coalesce(new.financial_year, nullif(new.payload->>'financialYear', ''));
  if (new.company_guid is null or new.financial_year is null) and jsonb_typeof(connection_row.last_companies_snapshot) = 'array' then
    select item into company_row
      from jsonb_array_elements(connection_row.last_companies_snapshot) item
     where lower(btrim(item->>'companyName')) = lower(btrim(new.company_name))
     order by case when coalesce((item->>'isActive')::boolean, false) then 0 else 1 end
     limit 1;
    new.company_guid := coalesce(new.company_guid, nullif(company_row->>'guid', ''));
    new.financial_year := coalesce(new.financial_year, nullif(company_row->>'financialYear', ''));
  end if;
  return new;
end $$;

revoke all on function public.populate_tally_agent_command_identity() from public;

do $$
begin
  if to_regclass('public.tally_bridge_commands') is not null then
    drop trigger if exists tally_bridge_commands_agent_identity on public.tally_bridge_commands;
    create trigger tally_bridge_commands_agent_identity
      before insert or update of connection_id, payload on public.tally_bridge_commands
      for each row execute function public.populate_tally_agent_command_identity();
  end if;
end $$;

create table if not exists public.tally_agent_datasets (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  organization_id text not null,
  connection_id uuid not null references public.tally_connections(id) on delete cascade,
  installation_id text not null,
  company_guid text not null,
  company_name text not null,
  financial_year text not null,
  agent_version text not null,
  protocol_version integer not null,
  tdl_version integer,
  local_schema_version integer,
  sync_cursors jsonb not null default '{}'::jsonb,
  cache_health jsonb not null default '{}'::jsonb,
  cache_size_bytes bigint not null default 0 check (cache_size_bytes >= 0),
  last_synced_at timestamptz,
  last_reconciled_at timestamptz,
  quarantined_at timestamptz,
  quarantine_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, connection_id, installation_id, company_guid, financial_year)
);

create index if not exists tally_agent_datasets_owner_lookup_idx
  on public.tally_agent_datasets
  (owner_user_id, organization_id, connection_id, installation_id, company_guid, financial_year);

alter table public.tally_agent_datasets enable row level security;

revoke all on table public.tally_agent_datasets from anon, authenticated;
grant select on table public.tally_agent_datasets to authenticated;
grant all on table public.tally_agent_datasets to service_role;

drop policy if exists tally_agent_datasets_owner_read on public.tally_agent_datasets;
create policy tally_agent_datasets_owner_read
  on public.tally_agent_datasets
  for select
  to authenticated
  using (owner_user_id = (select auth.uid()));

-- Historical workflow tables are optional between installations. Backfill only
-- when both the table and target column exist, so this migration is portable.
do $$
declare
  target_table text;
begin
  foreach target_table in array array['debit_note_proposals', 'purchase_posting_proposals'] loop
    if to_regclass('public.' || target_table) is not null
       and exists (
         select 1 from information_schema.columns
          where table_schema='public' and table_name=target_table and column_name='company_dataset_id'
       ) then
      execute format(
        'update public.%I p set company_dataset_id = d.id from public.tally_agent_datasets d where p.company_dataset_id is null and d.connection_id = p.tally_connection_id and d.company_guid = p.company_guid and d.financial_year = p.financial_year',
        target_table
      );
    end if;
  end loop;
exception
  when undefined_column then
    raise notice 'Skipped optional Local Agent workflow backfill because this installation has a different historical schema.';
end $$;
