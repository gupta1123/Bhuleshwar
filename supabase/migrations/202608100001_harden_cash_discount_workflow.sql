-- Cash Discount workflow hardening
-- 1. Database-enforced idempotency for active Tally debit-note commands.
-- 2. Owner-scoped RLS for all Collections workflow tables in public.

alter table if exists public.tally_bridge_commands
  add column if not exists idempotency_key text;

create unique index if not exists tally_bridge_commands_active_idempotency_idx
  on public.tally_bridge_commands (owner_user_id, command_type, idempotency_key)
  where idempotency_key is not null and status in ('queued', 'claimed');

-- Older connector retries could save the same Tally voucher more than once.
-- Retain the strongest row as the canonical history entry and keep duplicate
-- rows for audit purposes, but remove them from the successful-voucher set.
with ranked_guid_duplicates as (
  select
    id,
    first_value(id) over (
      partition by owner_user_id, connection_id, tally_voucher_guid
      order by
        (communication_status = 'sent') desc,
        created_in_tally_at desc nulls last,
        updated_at desc,
        created_at desc,
        id desc
    ) as canonical_id,
    row_number() over (
      partition by owner_user_id, connection_id, tally_voucher_guid
      order by
        (communication_status = 'sent') desc,
        created_in_tally_at desc nulls last,
        updated_at desc,
        created_at desc,
        id desc
    ) as duplicate_rank
  from public.debit_note_proposals
  where tally_voucher_guid is not null
    and status = 'created_in_tally'
), duplicate_guid_rows as (
  select id, canonical_id
  from ranked_guid_duplicates
  where duplicate_rank > 1
)
update public.debit_note_proposals as proposal
set
  status = 'failed',
  last_error = concat_ws(
    ' ',
    nullif(btrim(proposal.last_error), ''),
    format('Duplicate workflow row archived by migration; canonical proposal: %s.', duplicate.canonical_id)
  ),
  updated_at = now()
from duplicate_guid_rows as duplicate
where proposal.id = duplicate.id;

create unique index if not exists debit_note_proposals_tally_guid_owner_idx
  on public.debit_note_proposals (owner_user_id, connection_id, tally_voucher_guid)
  where tally_voucher_guid is not null and status = 'created_in_tally';

-- A few historical rows may lack a GUID but still share Tally's voucher ID.
-- Apply the same canonical-row rule before enforcing the second identifier.
with ranked_id_duplicates as (
  select
    id,
    first_value(id) over (
      partition by owner_user_id, connection_id, tally_voucher_id
      order by
        (communication_status = 'sent') desc,
        created_in_tally_at desc nulls last,
        updated_at desc,
        created_at desc,
        id desc
    ) as canonical_id,
    row_number() over (
      partition by owner_user_id, connection_id, tally_voucher_id
      order by
        (communication_status = 'sent') desc,
        created_in_tally_at desc nulls last,
        updated_at desc,
        created_at desc,
        id desc
    ) as duplicate_rank
  from public.debit_note_proposals
  where tally_voucher_id is not null
    and status = 'created_in_tally'
), duplicate_id_rows as (
  select id, canonical_id
  from ranked_id_duplicates
  where duplicate_rank > 1
)
update public.debit_note_proposals as proposal
set
  status = 'failed',
  last_error = concat_ws(
    ' ',
    nullif(btrim(proposal.last_error), ''),
    format('Duplicate workflow row archived by migration; canonical proposal: %s.', duplicate.canonical_id)
  ),
  updated_at = now()
from duplicate_id_rows as duplicate
where proposal.id = duplicate.id;

create unique index if not exists debit_note_proposals_tally_id_owner_idx
  on public.debit_note_proposals (owner_user_id, connection_id, tally_voucher_id)
  where tally_voucher_id is not null and status = 'created_in_tally';

alter table if exists public.cash_discount_rules enable row level security;
alter table if exists public.debit_note_proposals enable row level security;
alter table if exists public.collections_analysis_cache enable row level security;

drop policy if exists cash_discount_rules_owner_select on public.cash_discount_rules;
drop policy if exists cash_discount_rules_owner_insert on public.cash_discount_rules;
drop policy if exists cash_discount_rules_owner_update on public.cash_discount_rules;
drop policy if exists cash_discount_rules_owner_delete on public.cash_discount_rules;

create policy cash_discount_rules_owner_select
  on public.cash_discount_rules for select to authenticated
  using ((select auth.uid()) = owner_user_id);
create policy cash_discount_rules_owner_insert
  on public.cash_discount_rules for insert to authenticated
  with check ((select auth.uid()) = owner_user_id);
create policy cash_discount_rules_owner_update
  on public.cash_discount_rules for update to authenticated
  using ((select auth.uid()) = owner_user_id)
  with check ((select auth.uid()) = owner_user_id);
create policy cash_discount_rules_owner_delete
  on public.cash_discount_rules for delete to authenticated
  using ((select auth.uid()) = owner_user_id);

drop policy if exists debit_note_proposals_owner_select on public.debit_note_proposals;
drop policy if exists debit_note_proposals_owner_insert on public.debit_note_proposals;
drop policy if exists debit_note_proposals_owner_update on public.debit_note_proposals;
drop policy if exists debit_note_proposals_owner_delete on public.debit_note_proposals;

create policy debit_note_proposals_owner_select
  on public.debit_note_proposals for select to authenticated
  using ((select auth.uid()) = owner_user_id);
create policy debit_note_proposals_owner_insert
  on public.debit_note_proposals for insert to authenticated
  with check ((select auth.uid()) = owner_user_id);
create policy debit_note_proposals_owner_update
  on public.debit_note_proposals for update to authenticated
  using ((select auth.uid()) = owner_user_id)
  with check ((select auth.uid()) = owner_user_id);
create policy debit_note_proposals_owner_delete
  on public.debit_note_proposals for delete to authenticated
  using ((select auth.uid()) = owner_user_id);

drop policy if exists collections_analysis_cache_owner_select on public.collections_analysis_cache;
drop policy if exists collections_analysis_cache_owner_insert on public.collections_analysis_cache;
drop policy if exists collections_analysis_cache_owner_update on public.collections_analysis_cache;
drop policy if exists collections_analysis_cache_owner_delete on public.collections_analysis_cache;

create policy collections_analysis_cache_owner_select
  on public.collections_analysis_cache for select to authenticated
  using ((select auth.uid()) = owner_user_id);
create policy collections_analysis_cache_owner_insert
  on public.collections_analysis_cache for insert to authenticated
  with check ((select auth.uid()) = owner_user_id);
create policy collections_analysis_cache_owner_update
  on public.collections_analysis_cache for update to authenticated
  using ((select auth.uid()) = owner_user_id)
  with check ((select auth.uid()) = owner_user_id);
create policy collections_analysis_cache_owner_delete
  on public.collections_analysis_cache for delete to authenticated
  using ((select auth.uid()) = owner_user_id);
