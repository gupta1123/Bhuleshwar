-- Collections Debit Note History & Contact Snapshot
-- Run after 202607070001_collections_cash_discount.sql.
-- Tally remains the accounting source of truth. These fields keep the workflow
-- auditable and make the Collections screen useful before/after creation.

alter table if exists public.debit_note_proposals
  add column if not exists party_email text,
  add column if not exists party_phone text,
  add column if not exists party_contact_person text,
  add column if not exists party_address text,
  add column if not exists tally_voucher_id text,
  add column if not exists tally_open_reference_name text,
  add column if not exists remaining_recoverable_amount numeric(14, 2),
  add column if not exists created_in_tally_at timestamptz,
  add column if not exists last_synced_from_tally_at timestamptz,
  add column if not exists communication_status text not null default 'not_sent',
  add column if not exists communication_channel text,
  add column if not exists communication_recipient text,
  add column if not exists communication_sent_at timestamptz,
  add column if not exists customer_snapshot jsonb not null default '{}'::jsonb;

do $$
begin
  if to_regclass('public.debit_note_proposals') is not null then
    alter table public.debit_note_proposals
      drop constraint if exists debit_note_proposals_communication_status_check;

    alter table public.debit_note_proposals
      add constraint debit_note_proposals_communication_status_check
      check (communication_status in ('not_sent', 'drafted', 'sent', 'failed', 'not_required'));
  end if;
end
$$;

update public.debit_note_proposals
set
  created_in_tally_at = coalesce(created_in_tally_at, updated_at),
  remaining_recoverable_amount = coalesce(remaining_recoverable_amount, recoverable_amount),
  tally_open_reference_name = coalesce(tally_open_reference_name, tally_voucher_number)
where status = 'created_in_tally';

create index if not exists debit_note_proposals_created_history_idx
  on public.debit_note_proposals(owner_user_id, connection_id, status, created_in_tally_at desc);

create index if not exists debit_note_proposals_party_contact_idx
  on public.debit_note_proposals(owner_user_id, connection_id, party_ledger_name);
