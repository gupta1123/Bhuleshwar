create table if not exists public.storage_assets (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  storage_bucket text not null,
  storage_path text not null,
  content_sha256 text,
  size_bytes bigint not null check (size_bytes >= 0),
  mime_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint storage_assets_bucket_path_key unique (storage_bucket, storage_path)
);

alter table public.storage_assets enable row level security;

drop policy if exists "Users can read their storage assets" on public.storage_assets;
create policy "Users can read their storage assets"
  on public.storage_assets
  for select
  using (auth.uid() = owner_user_id);

alter table public.packet_case_files
  add column if not exists storage_asset_id uuid references public.storage_assets(id) on delete restrict,
  add column if not exists content_sha256 text;

create index if not exists packet_case_files_storage_asset_id_idx
  on public.packet_case_files(storage_asset_id);
create index if not exists packet_case_files_content_lookup_idx
  on public.packet_case_files(content_sha256, size_bytes);
create index if not exists storage_assets_owner_content_idx
  on public.storage_assets(owner_user_id, storage_bucket, content_sha256, size_bytes);
create unique index if not exists storage_assets_owner_hash_size_key
  on public.storage_assets(owner_user_id, storage_bucket, content_sha256, size_bytes)
  where content_sha256 is not null;

insert into public.storage_assets (
  owner_user_id,
  storage_bucket,
  storage_path,
  size_bytes,
  mime_type
)
select distinct on (coalesce(f.storage_bucket, 'packet-files'), f.storage_path)
  c.owner_user_id,
  coalesce(f.storage_bucket, 'packet-files'),
  f.storage_path,
  coalesce(f.size_bytes, 0),
  f.mime_type
from public.packet_case_files f
join public.packet_cases c on c.id = f.case_id
where f.storage_path is not null
on conflict (storage_bucket, storage_path) do nothing;

update public.packet_case_files f
set storage_asset_id = a.id
from public.packet_cases c,
     public.storage_assets a
where c.id = f.case_id
  and a.owner_user_id = c.owner_user_id
  and a.storage_bucket = coalesce(f.storage_bucket, 'packet-files')
  and a.storage_path = f.storage_path
  and f.storage_asset_id is null;
