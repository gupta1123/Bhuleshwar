create or replace function public.list_storage_duplicate_candidates(p_bucket text)
returns table (
  etag text,
  size_bytes bigint,
  copies bigint,
  redundant_bytes numeric,
  objects jsonb
)
language sql
security definer
set search_path = public, storage
as $$
  with candidates as (
    select
      lower(coalesce(o.metadata->>'eTag', o.metadata->>'etag')) as etag,
      (o.metadata->>'size')::bigint as size_bytes,
      o.name as storage_path,
      o.created_at
    from storage.objects o
    where o.bucket_id = p_bucket
      and coalesce(o.metadata->>'eTag', o.metadata->>'etag') is not null
      and coalesce(o.metadata->>'size', '') ~ '^[0-9]+$'
  )
  select
    c.etag,
    c.size_bytes,
    count(*)::bigint as copies,
    ((count(*) - 1) * c.size_bytes)::numeric as redundant_bytes,
    jsonb_agg(
      jsonb_build_object(
        'storagePath', c.storage_path,
        'createdAt', c.created_at,
        'assetId', a.id,
        'ownerUserId', a.owner_user_id
      )
      order by c.created_at, c.storage_path
    ) as objects
  from candidates c
  left join public.storage_assets a
    on a.storage_bucket = p_bucket
   and a.storage_path = c.storage_path
  group by c.etag, c.size_bytes
  having count(*) > 1
  order by ((count(*) - 1) * c.size_bytes) desc, count(*) desc;
$$;

revoke all on function public.list_storage_duplicate_candidates(text) from public, anon, authenticated;
grant execute on function public.list_storage_duplicate_candidates(text) to service_role;

create or replace function public.consolidate_storage_assets(
  p_canonical_asset_id uuid,
  p_duplicate_asset_ids uuid[],
  p_content_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  canonical public.storage_assets%rowtype;
  invalid_count integer;
  packet_count integer;
begin
  if p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A lowercase SHA-256 checksum is required.';
  end if;

  select * into canonical
  from public.storage_assets
  where id = p_canonical_asset_id
  for update;

  if canonical.id is null then
    raise exception 'Canonical storage asset not found.';
  end if;

  select count(*) into invalid_count
  from public.storage_assets a
  where a.id = any(coalesce(p_duplicate_asset_ids, array[]::uuid[]))
    and (
      a.owner_user_id <> canonical.owner_user_id
      or a.storage_bucket <> canonical.storage_bucket
      or a.size_bytes <> canonical.size_bytes
      or a.id = canonical.id
    );

  if invalid_count > 0 then
    raise exception 'Duplicate assets must have the same owner, bucket and size as the canonical asset.';
  end if;

  if (
    select count(*)
    from public.storage_assets a
    where a.id = any(coalesce(p_duplicate_asset_ids, array[]::uuid[]))
  ) <> coalesce(array_length(p_duplicate_asset_ids, 1), 0) then
    raise exception 'One or more duplicate assets were not found.';
  end if;

  update public.packet_case_files
  set storage_asset_id = canonical.id,
      storage_bucket = canonical.storage_bucket,
      storage_path = canonical.storage_path,
      content_sha256 = p_content_sha256
  where storage_asset_id = any(coalesce(p_duplicate_asset_ids, array[]::uuid[]));
  get diagnostics packet_count = row_count;

  update public.packet_case_files
  set content_sha256 = p_content_sha256
  where storage_asset_id = canonical.id;

  update public.storage_assets
  set content_sha256 = p_content_sha256,
      updated_at = now()
  where id = canonical.id;

  return jsonb_build_object(
    'canonicalAssetId', canonical.id,
    'canonicalPath', canonical.storage_path,
    'packetReferencesMoved', packet_count,
    'duplicateAssetsRetainedUntilStorageRemoval', coalesce(array_length(p_duplicate_asset_ids, 1), 0)
  );
end;
$$;

revoke all on function public.consolidate_storage_assets(uuid, uuid[], text) from public, anon, authenticated;
grant execute on function public.consolidate_storage_assets(uuid, uuid[], text) to service_role;
