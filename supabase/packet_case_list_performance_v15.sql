-- Fast case directory pagination and search.
-- Additive only: no data deletion and safe to run repeatedly.

create extension if not exists pg_trgm with schema extensions;

alter table public.packet_cases
add column if not exists search_text text generated always as (
  lower(
    coalesce(display_name, '') || ' ' ||
    coalesce(buyer_name, '') || ' ' ||
    coalesce(po_number, '') || ' ' ||
    coalesce(invoice_number, '') || ' ' ||
    coalesce(slug, '')
  )
) stored;

create index if not exists packet_cases_active_owner_created_id_idx
on public.packet_cases (owner_user_id, created_at desc, id desc)
where deleted_at is null;

create index if not exists packet_cases_deleted_owner_deleted_id_idx
on public.packet_cases (owner_user_id, deleted_at desc, id desc)
where deleted_at is not null;

create index if not exists packet_cases_search_text_trgm_idx
on public.packet_cases
using gin (search_text gin_trgm_ops);
