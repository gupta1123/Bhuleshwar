-- Collections & Cash Discount Control
-- Run this manually in Supabase before using the collections dashboard.
-- This migration intentionally stores workflow data only. Tally remains the
-- source of truth for invoices, vouchers, ledger balances, and outstanding bills.

create table if not exists public.cash_discount_rules (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  connection_id uuid references public.tally_connections(id) on delete cascade,
  rule_name text not null,
  scope_type text not null default 'company'
    check (scope_type in ('company', 'customer_group', 'customer', 'invoice', 'sales_order')),
  scope_key text,
  scope_label text,
  discount_type text not null default 'percentage'
    check (discount_type in ('percentage', 'fixed_amount')),
  discount_value numeric(14, 2) not null default 0,
  calculation_base text not null default 'invoice_total'
    check (calculation_base in ('taxable_value', 'invoice_total', 'product_value')),
  eligibility_days integer not null default 0,
  grace_days integer not null default 0,
  payment_condition text not null default 'full_payment'
    check (payment_condition in ('full_payment', 'pro_rata', 'manual_review')),
  accounting_treatment text not null default 'finance_review'
    check (accounting_treatment in ('credit_note', 'commercial_credit_note', 'pre_discounted_invoice', 'finance_review')),
  missed_cd_treatment text not null default 'finance_review'
    check (missed_cd_treatment in ('no_action', 'debit_note_proposal', 'follow_up_only', 'finance_review')),
  approval_required boolean not null default true,
  label text not null default 'Cash Discount',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cash_discount_rules_owner_connection_idx
  on public.cash_discount_rules(owner_user_id, connection_id, is_active);

create table if not exists public.debit_note_proposals (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  connection_id uuid references public.tally_connections(id) on delete cascade,
  company_name text,
  financial_year text,
  -- Bhuleshwar's live cash-discount workflow does not require the optional
  -- bank-statement module. Keep the source id as metadata without requiring
  -- the bank_transactions table to exist in this project.
  source_transaction_id uuid,
  party_ledger_name text not null,
  party_gstin text,
  linked_invoice_number text,
  linked_invoice_date date,
  original_invoice_amount numeric(14, 2),
  cash_discount_rule_id uuid references public.cash_discount_rules(id) on delete set null,
  cash_discount_rule_name text,
  discount_deadline date,
  receipt_date date,
  amount_received numeric(14, 2),
  recoverable_amount numeric(14, 2) not null default 0,
  reason_code text not null default 'cash_discount_expired',
  narration text,
  gst_mode text not null default 'finance_review',
  debit_note_date date not null default current_date,
  status text not null default 'draft'
    check (status in ('draft', 'pending_approval', 'approved', 'queued_in_tally', 'created_in_tally', 'rejected', 'failed')),
  approval_by uuid,
  approved_at timestamptz,
  tally_command_id uuid,
  tally_voucher_guid text,
  tally_voucher_number text,
  tally_voucher_date date,
  tally_pdf_reference text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists debit_note_proposals_owner_connection_status_idx
  on public.debit_note_proposals(owner_user_id, connection_id, status, created_at desc);

create table if not exists public.collections_analysis_cache (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  connection_id uuid references public.tally_connections(id) on delete cascade,
  cache_key text not null,
  company_name text,
  financial_year text,
  period_start date,
  period_end date,
  payload jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (owner_user_id, connection_id, cache_key)
);

create index if not exists collections_analysis_cache_expiry_idx
  on public.collections_analysis_cache(expires_at);

do $$
begin
  if to_regclass('public.tally_bridge_commands') is not null then
    alter table public.tally_bridge_commands
      drop constraint if exists tally_bridge_commands_command_type_check;

    alter table public.tally_bridge_commands
      add constraint tally_bridge_commands_command_type_check
      check (
        command_type in (
          'alter_ledger',
          'create_ledger',
          'sync_masters',
          'post_bank_voucher',
          'fetch_customer_open_bills',
          'create_debit_note'
        )
      );
  end if;
end
$$;
