create table if not exists public.cash_discount_customer_scope_settings (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.tally_connections(id) on delete cascade,
  company_name text not null check (length(btrim(company_name)) between 1 and 240),
  company_name_key text not null check (length(btrim(company_name_key)) between 1 and 240),
  mode text not null default 'automatic' check (mode in ('automatic', 'custom', 'strict')),
  selected_group_names text[] not null default array['Sundry Debtors']::text[],
  include_nested_groups boolean not null default true,
  detect_sales_linked_exceptions boolean not null default true,
  excluded_group_names text[] not null default '{}'::text[],
  excluded_ledger_names text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cash_discount_customer_scope_owner_company_unique
    unique (owner_user_id, connection_id, company_name_key)
);

alter table public.cash_discount_customer_scope_settings enable row level security;

drop trigger if exists cash_discount_customer_scope_set_updated_at
  on public.cash_discount_customer_scope_settings;
create trigger cash_discount_customer_scope_set_updated_at
before update on public.cash_discount_customer_scope_settings
for each row execute function public.set_packet_updated_at();

drop policy if exists cash_discount_customer_scope_owner_select
  on public.cash_discount_customer_scope_settings;
create policy cash_discount_customer_scope_owner_select
on public.cash_discount_customer_scope_settings for select to authenticated
using ((select auth.uid()) = owner_user_id);

drop policy if exists cash_discount_customer_scope_owner_insert
  on public.cash_discount_customer_scope_settings;
create policy cash_discount_customer_scope_owner_insert
on public.cash_discount_customer_scope_settings for insert to authenticated
with check (
  (select auth.uid()) = owner_user_id
  and exists (
    select 1 from public.tally_connections connection
    where connection.id = connection_id
      and connection.owner_user_id = (select auth.uid())
  )
);

drop policy if exists cash_discount_customer_scope_owner_update
  on public.cash_discount_customer_scope_settings;
create policy cash_discount_customer_scope_owner_update
on public.cash_discount_customer_scope_settings for update to authenticated
using ((select auth.uid()) = owner_user_id)
with check (
  (select auth.uid()) = owner_user_id
  and exists (
    select 1 from public.tally_connections connection
    where connection.id = connection_id
      and connection.owner_user_id = (select auth.uid())
  )
);

drop policy if exists cash_discount_customer_scope_owner_delete
  on public.cash_discount_customer_scope_settings;
create policy cash_discount_customer_scope_owner_delete
on public.cash_discount_customer_scope_settings for delete to authenticated
using ((select auth.uid()) = owner_user_id);

revoke all on table public.cash_discount_customer_scope_settings from anon;
grant select, insert, update, delete on table public.cash_discount_customer_scope_settings to authenticated;
grant all on table public.cash_discount_customer_scope_settings to service_role;
