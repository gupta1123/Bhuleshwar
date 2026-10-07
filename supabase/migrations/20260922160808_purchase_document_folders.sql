-- Company-wide purchase PDF storage. Apply manually before deploying the API.
-- Access is mediated by the settings API and its company permission checks.
create table public.purchase_document_folders (
  organization_id text not null,
  company_key text not null,
  folder_path text not null default '' check (length(folder_path) <= 500),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, company_key)
);
alter table public.purchase_document_folders enable row level security;
revoke all on public.purchase_document_folders from anon, authenticated;
grant select, insert, update, delete on public.purchase_document_folders to service_role;
comment on table public.purchase_document_folders is
  'Company shared purchase PDF folder. Team company UUID is stable across connector installations; legacy scope uses connection and company name. Server-authorized access only.';
