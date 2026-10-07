insert into public.field_settings (organization_id, doc_type, field_key, enabled, updated_at)
values
  ('default', 'FASTag Toll Proof', 'fastagStatementReference', true, now()),
  ('default', 'FASTag Toll Proof', 'fastagCustomerId', true, now()),
  ('default', 'FASTag Toll Proof', 'fastagCustomerName', true, now()),
  ('default', 'FASTag Toll Proof', 'statementPeriod', true, now()),
  ('default', 'FASTag Toll Proof', 'statementDate', true, now()),
  ('default', 'FASTag Toll Proof', 'tripCount', true, now()),
  ('default', 'FASTag Toll Proof', 'openingBalance', true, now()),
  ('default', 'FASTag Toll Proof', 'creditAmount', true, now()),
  ('default', 'FASTag Toll Proof', 'debitAmount', true, now()),
  ('default', 'FASTag Toll Proof', 'closingBalance', true, now()),
  ('default', 'FASTag Toll Proof', 'tollTransactionSummary', true, now())
on conflict (organization_id, doc_type, field_key) do update
set
  enabled = excluded.enabled,
  updated_at = excluded.updated_at;
