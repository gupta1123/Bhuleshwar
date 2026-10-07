insert into public.field_settings (
  organization_id,
  doc_type,
  field_key,
  enabled,
  updated_at
)
values
  ('default', 'E-Way Bill', 'dispatchFrom', true, now()),
  ('default', 'E-Way Bill', 'shipTo', true, now())
on conflict (organization_id, doc_type, field_key) do nothing;
