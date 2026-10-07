-- Purchase invoice -> Tally Purchase voucher workflow.
-- Case approval remains owned by packet_cases.status. The tables below keep
-- Tally review, approval, queueing, creation, and verification independent.

alter table public.tally_master_sync_runs
  add column if not exists company_gstin text,
  add column if not exists company_state_code text;

alter table public.tally_masters
  add column if not exists company_name text;

update public.tally_masters as master
set company_name = coalesce(
  (
    select sync_run.company_name
    from public.tally_master_sync_runs as sync_run
    where sync_run.id = master.sync_run_id
  ),
  connection.last_company_name,
  'Unknown company'
)
from public.tally_connections as connection
where connection.id = master.connection_id
  and (master.company_name is null or btrim(master.company_name) = '');

alter table public.tally_masters
  alter column company_name set default 'Unknown company';

update public.tally_masters
set company_name = 'Unknown company'
where company_name is null or btrim(company_name) = '';

alter table public.tally_masters
  alter column company_name set not null;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.tally_masters'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%connection_id%master_type%master_key%'
  loop
    execute format('alter table public.tally_masters drop constraint %I', constraint_name);
  end loop;
end
$$;

alter table public.tally_masters
  add constraint tally_masters_connection_company_type_key_unique
  unique (connection_id, company_name, master_type, master_key);

create index if not exists tally_masters_connection_company_active_idx
  on public.tally_masters(connection_id, company_name, master_type, is_active);

alter table public.tally_mapping_settings
  add column if not exists company_name text;

update public.tally_mapping_settings as mapping
set company_name = coalesce(connection.last_company_name, 'Unknown company')
from public.tally_connections as connection
where connection.id = mapping.connection_id
  and (mapping.company_name is null or btrim(mapping.company_name) = '');

alter table public.tally_mapping_settings
  alter column company_name set default 'Unknown company';

update public.tally_mapping_settings
set company_name = 'Unknown company'
where company_name is null or btrim(company_name) = '';

alter table public.tally_mapping_settings
  alter column company_name set not null;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.tally_mapping_settings'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%connection_id%mapping_type%source_key%'
  loop
    execute format('alter table public.tally_mapping_settings drop constraint %I', constraint_name);
  end loop;
end
$$;

alter table public.tally_mapping_settings
  drop constraint if exists tally_mapping_settings_mapping_type_check;

alter table public.tally_mapping_settings
  add constraint tally_mapping_settings_mapping_type_check
  check (
    mapping_type in (
      'supplier_gstin',
      'buyer_gstin',
      'item_hsn',
      'item_description',
      'gst_rate',
      'purchase_ledger',
      'tds_ledger',
      'tcs_ledger',
      'stock_unit',
      'freight_ledger',
      'round_off_ledger',
      'voucher_type',
      'bank_account_ledger',
      'bank_narration_ledger',
      'bank_category_ledger'
    )
  );

alter table public.tally_mapping_settings
  add constraint tally_mapping_settings_connection_company_type_source_unique
  unique (connection_id, company_name, mapping_type, source_key);

-- Data-minimized posting state. Invoice source data stays in packet_documents.
-- Only user changes, hashes, lifecycle state, and final Tally identifiers live here.
create table if not exists public.purchase_invoice_tally_postings (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.packet_cases(id) on delete cascade,
  invoice_document_id uuid references public.packet_documents(id) on delete set null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid references public.tally_connections(id) on delete set null,
  master_sync_run_id uuid references public.tally_master_sync_runs(id) on delete set null,
  command_id uuid references public.tally_bridge_commands(id) on delete set null,
  status text not null default 'draft'
    check (status in (
      'draft',
      'correction_required',
      'ready_for_approval',
      'approved',
      'queued',
      'creating',
      'created',
      'failed'
    )),
  revision integer not null default 1 check (revision > 0),
  duplicate_key text,
  idempotency_key text,
  review_patch jsonb not null default '{}'::jsonb,
  approved_payload_hash text,
  approved_at timestamptz,
  queued_at timestamptz,
  tally_voucher_number text,
  tally_master_id text,
  tally_guid text,
  tally_created_at timestamptz,
  verified_at timestamptz,
  verification_status text,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (case_id)
);

-- Only one approved/in-flight/created posting may claim a supplier invoice in
-- a Tally company. Drafts can coexist so duplicate cases remain reviewable.
create unique index if not exists purchase_invoice_tally_postings_duplicate_claim_idx
  on public.purchase_invoice_tally_postings(owner_user_id, duplicate_key)
  where duplicate_key is not null
    and status in ('approved', 'queued', 'creating', 'created');

create index if not exists purchase_invoice_tally_postings_owner_status_idx
  on public.purchase_invoice_tally_postings(owner_user_id, status, updated_at desc);

create index if not exists purchase_invoice_tally_postings_command_idx
  on public.purchase_invoice_tally_postings(command_id)
  where command_id is not null;

alter table public.purchase_invoice_tally_postings enable row level security;

drop trigger if exists set_purchase_invoice_tally_postings_updated_at
  on public.purchase_invoice_tally_postings;
create trigger set_purchase_invoice_tally_postings_updated_at
before update on public.purchase_invoice_tally_postings
for each row execute function public.set_packet_updated_at();

create or replace function public.scrub_purchase_command_on_posting_delete()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.command_id is not null then
    update public.tally_bridge_commands
    set payload = '{}'::jsonb,
        result = '{}'::jsonb,
        status = case when status in ('queued', 'claimed') then 'canceled' else status end,
        error = case
          when status in ('queued', 'claimed') then 'Purchase posting was deleted before completion.'
          else error
        end,
        completed_at = case
          when status in ('queued', 'claimed') then coalesce(completed_at, timezone('utc', now()))
          else completed_at
        end
    where id = old.command_id;
  end if;
  return old;
end;
$$;

revoke all on function public.scrub_purchase_command_on_posting_delete()
  from public, anon, authenticated;

drop trigger if exists scrub_purchase_command_on_posting_delete
  on public.purchase_invoice_tally_postings;
create trigger scrub_purchase_command_on_posting_delete
before delete on public.purchase_invoice_tally_postings
for each row execute function public.scrub_purchase_command_on_posting_delete();

drop policy if exists purchase_invoice_tally_postings_owner_select
  on public.purchase_invoice_tally_postings;
create policy purchase_invoice_tally_postings_owner_select
  on public.purchase_invoice_tally_postings
  for select to authenticated
  using (owner_user_id = (select auth.uid()));

drop policy if exists purchase_invoice_tally_postings_owner_insert
  on public.purchase_invoice_tally_postings;
create policy purchase_invoice_tally_postings_owner_insert
  on public.purchase_invoice_tally_postings
  for insert to authenticated
  with check (owner_user_id = (select auth.uid()));

drop policy if exists purchase_invoice_tally_postings_owner_update
  on public.purchase_invoice_tally_postings;
create policy purchase_invoice_tally_postings_owner_update
  on public.purchase_invoice_tally_postings
  for update to authenticated
  using (owner_user_id = (select auth.uid()))
  with check (owner_user_id = (select auth.uid()));

-- The application accesses this table only from the backend service client.
-- Keep browser roles ungranted even though owner-scoped RLS remains enabled.
grant select, insert, update, delete
  on table public.purchase_invoice_tally_postings
  to service_role;

alter table public.tally_bridge_commands
  drop constraint if exists tally_bridge_commands_command_type_check;

alter table public.tally_bridge_commands
  add constraint tally_bridge_commands_command_type_check
  check (
    command_type in (
      'alter_ledger',
      'create_ledger',
      'fetch_bank_ledgers',
      'sync_masters',
      'post_bank_voucher',
      'post_purchase_voucher', -- Legacy completed commands retained for history.
      'fetch_customer_open_bills',
      'create_debit_note',
      'export_debit_note_pdf',
      'verify_bank_transaction',
      'create_purchase_voucher'
    )
  );

-- Approval and command creation must be atomic. The full voucher payload is
-- retained only on the live bridge command and is scrubbed when it completes,
-- exhausts its retries, or its posting is deleted.
create or replace function public.queue_purchase_invoice_tally_posting(
  p_posting_id uuid,
  p_owner_user_id uuid,
  p_connection_id uuid,
  p_master_sync_run_id uuid,
  p_duplicate_key text,
  p_idempotency_key text,
  p_approved_payload_hash text,
  p_approved_at timestamptz,
  p_tally_payload jsonb,
  p_revision integer
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  posting_row public.purchase_invoice_tally_postings%rowtype;
  new_command_id uuid;
begin
  select *
  into posting_row
  from public.purchase_invoice_tally_postings
  where id = p_posting_id
    and owner_user_id = p_owner_user_id
  for update;

  if not found then
    raise exception 'Purchase posting not found';
  end if;

  if posting_row.status in ('queued', 'creating', 'created') then
    if posting_row.command_id is null then
      raise exception 'Queued purchase posting has no command';
    end if;
    return posting_row.command_id;
  end if;

  if posting_row.status not in ('draft', 'correction_required', 'ready_for_approval', 'failed') then
    raise exception 'Purchase posting cannot be approved from status %', posting_row.status;
  end if;

  if posting_row.revision <> p_revision then
    raise exception 'Purchase posting revision changed before approval';
  end if;

  update public.purchase_invoice_tally_postings
  set status = 'approved',
      connection_id = p_connection_id,
      master_sync_run_id = p_master_sync_run_id,
      approved_at = p_approved_at,
      idempotency_key = p_idempotency_key,
      duplicate_key = p_duplicate_key,
      approved_payload_hash = p_approved_payload_hash,
      last_error = null
  where id = p_posting_id;

  insert into public.tally_bridge_commands (
    connection_id,
    owner_user_id,
    command_type,
    status,
    priority,
    payload,
    max_attempts
  ) values (
    p_connection_id,
    p_owner_user_id,
    'create_purchase_voucher',
    'queued',
    40,
    p_tally_payload,
    3
  )
  returning id into new_command_id;

  update public.purchase_invoice_tally_postings
  set status = 'queued',
      command_id = new_command_id,
      queued_at = p_approved_at
  where id = p_posting_id;

  return new_command_id;
end;
$$;

revoke all on function public.queue_purchase_invoice_tally_posting(
  uuid, uuid, uuid, uuid, text, text, text, timestamptz, jsonb, integer
) from public, anon, authenticated;

grant execute on function public.queue_purchase_invoice_tally_posting(
  uuid, uuid, uuid, uuid, text, text, text, timestamptz, jsonb, integer
) to service_role;
