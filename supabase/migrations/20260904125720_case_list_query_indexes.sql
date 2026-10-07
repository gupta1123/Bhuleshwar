-- MANUAL ONLY. Kalika project ktpaupxmlbtpjgvigmpb; never Gajkesari.
-- Additive repair of missing v3/v15 directory prerequisites. No case deletion.
-- Run off-peak: stored-column backfill and ordinary indexes can block writes.
-- Lock acquisition is bounded; retry later if the table is busy.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.packet_cases add column if not exists deleted_at timestamptz;
alter table public.packet_cases add column if not exists deleted_by_user_id uuid references auth.users(id) on delete set null;

-- Do not resurrect previously recycled cases when switching to SQL filtering.
-- Invalid historical timestamps fail the transaction instead of silently losing
-- recycle-bin state. Fix the bad metadata before retrying if this fails.
update public.packet_cases
set deleted_at = (processing_meta->'recycleBin'->>'deletedAt')::timestamptz
where deleted_at is null and nullif(btrim(processing_meta->'recycleBin'->>'deletedAt'),'') is not null;

update public.packet_cases p
set deleted_by_user_id = u.id
from auth.users u
where p.deleted_by_user_id is null
  and p.processing_meta->'recycleBin'->>'deletedByUserId' = u.id::text;

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
alter table public.packet_cases add column if not exists search_text text generated always as (
  lower(coalesce(display_name,'') || ' ' || coalesce(buyer_name,'') || ' ' ||
    coalesce(po_number,'') || ' ' || coalesce(invoice_number,'') || ' ' || coalesce(slug,''))
) stored;

create index if not exists packet_cases_active_owner_created_id_idx
  on public.packet_cases(owner_user_id,created_at desc,id desc) where deleted_at is null;
create index if not exists packet_cases_deleted_owner_deleted_id_idx
  on public.packet_cases(owner_user_id,deleted_at desc,id desc) where deleted_at is not null;
-- Resolve the extension schema instead of assuming pg_trgm was installed in
-- public (older scripts did assume that).
do $$ declare extension_schema text; begin
  select n.nspname into extension_schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_trgm';
  execute format('create index if not exists packet_cases_search_text_trgm_idx on public.packet_cases using gin (search_text %I.gin_trgm_ops)',extension_schema);
end $$;
-- Keep existing RLS and grants unchanged; no new exposed table/view/function.
analyze public.packet_cases;
commit;
