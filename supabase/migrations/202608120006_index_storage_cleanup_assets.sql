create index if not exists storage_cleanup_queue_asset_idx
  on public.storage_cleanup_queue (storage_asset_id)
  where storage_asset_id is not null;
