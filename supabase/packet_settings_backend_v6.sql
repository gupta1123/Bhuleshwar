create extension if not exists pgcrypto;

create table if not exists public.field_settings (
  id uuid default gen_random_uuid() primary key,
  organization_id text default 'default',
  doc_type text not null,
  field_key text not null,
  enabled boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (organization_id, doc_type, field_key)
);

create table if not exists public.doc_type_settings (
  id uuid default gen_random_uuid() primary key,
  organization_id text default 'default',
  doc_type text not null,
  enabled boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (organization_id, doc_type)
);

create index if not exists field_settings_org_doc_type_idx
  on public.field_settings (organization_id, doc_type);

create index if not exists doc_type_settings_org_doc_type_idx
  on public.doc_type_settings (organization_id, doc_type);
