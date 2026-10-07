-- Purchase posting mapping hardening.
-- Apply this migration before using the optional identity fields below.
-- It is intentionally not applied by the local implementation task.

alter table public.tally_masters
  add column if not exists group_path text;

alter table public.tally_mapping_settings
  add column if not exists target_tally_guid text,
  add column if not exists target_group_path text,
  add column if not exists company_identity text;

create index if not exists tally_masters_connection_company_guid_idx
  on public.tally_masters (connection_id, company_name, tally_guid)
  where is_active = true;

create index if not exists tally_mapping_settings_identity_idx
  on public.tally_mapping_settings (owner_user_id, company_identity, mapping_type, source_key)
  where status = 'active';

comment on column public.tally_mapping_settings.target_tally_guid is
  'Stable Tally master GUID captured when the mapping was saved.';
comment on column public.tally_mapping_settings.target_group_path is
  'Full Tally group hierarchy captured when the mapping was saved.';
comment on column public.tally_mapping_settings.company_identity is
  'Stable company identity used to restore mappings after connector re-pairing.';
