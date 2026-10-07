create or replace function public.set_packet_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.packet_cases (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  display_name text not null,
  buyer_name text,
  po_number text,
  invoice_number text,
  status text not null default 'completed' check (status in ('processing', 'completed', 'failed')),
  risk_score integer not null default 0 check (risk_score between 0 and 100),
  upload_count integer not null default 0,
  document_count integer not null default 0,
  mismatch_count integer not null default 0,
  processing_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.packet_case_files (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.packet_cases(id) on delete cascade,
  original_name text not null,
  storage_bucket text not null default 'packet-files',
  storage_path text not null unique,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.packet_documents (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.packet_cases(id) on delete cascade,
  client_document_id text,
  source_file_name text,
  source_hint text,
  document_type text not null,
  title text not null,
  page_count integer not null default 0,
  extracted_fields jsonb not null default '{}'::jsonb,
  markdown text not null default '',
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.packet_mismatches (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.packet_cases(id) on delete cascade,
  client_mismatch_id text,
  field_name text not null,
  values_json jsonb not null default '[]'::jsonb,
  analysis text,
  fix_plan text,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists packet_cases_created_at_idx on public.packet_cases (created_at desc);
create index if not exists packet_cases_slug_idx on public.packet_cases (slug);
create index if not exists packet_case_files_case_id_idx on public.packet_case_files (case_id);
create index if not exists packet_documents_case_id_idx on public.packet_documents (case_id);
create index if not exists packet_documents_document_type_idx on public.packet_documents (document_type);
create index if not exists packet_mismatches_case_id_idx on public.packet_mismatches (case_id);

alter table public.packet_cases enable row level security;
alter table public.packet_case_files enable row level security;
alter table public.packet_documents enable row level security;
alter table public.packet_mismatches enable row level security;

drop trigger if exists set_packet_cases_updated_at on public.packet_cases;
create trigger set_packet_cases_updated_at
before update on public.packet_cases
for each row
execute function public.set_packet_updated_at();

insert into storage.buckets (id, name, public)
values ('packet-files', 'packet-files', false)
on conflict (id) do update
set public = excluded.public;
