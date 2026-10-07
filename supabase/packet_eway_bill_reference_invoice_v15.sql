insert into public.field_settings (
  organization_id,
  doc_type,
  field_key,
  enabled,
  updated_at
)
values
  ('default', 'E-Way Bill', 'referenceInvoiceNumber', true, now())
on conflict (organization_id, doc_type, field_key) do nothing;
