-- Prevent a voucher that may already exist in Tally from being queued again.
-- Apply this after 202607270001_purchase_invoice_tally_posting.sql.

alter table public.purchase_invoice_tally_postings
  drop constraint if exists purchase_invoice_tally_postings_status_check;

alter table public.purchase_invoice_tally_postings
  add constraint purchase_invoice_tally_postings_status_check
  check (status in (
    'draft',
    'correction_required',
    'ready_for_approval',
    'approved',
    'queued',
    'creating',
    'created',
    'verification_required',
    'failed'
  ));

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

  if posting_row.status = 'verification_required'
     or posting_row.tally_created_at is not null then
    raise exception 'Purchase voucher may already exist in Tally and must be verified before another create command';
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
