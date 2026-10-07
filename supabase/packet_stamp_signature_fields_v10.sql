delete from public.field_settings
where organization_id = 'default'
  and doc_type = 'Lorry Receipt'
  and field_key in ('hasVendorStamp', 'hasStoreStamp', 'hasStoreSignature', 'hasGateStamp');

insert into public.field_settings (organization_id, doc_type, field_key, enabled, updated_at)
values
  ('default', 'Purchase Order', 'hasAuthorizedSignature', true, now()),
  ('default', 'Purchase Order', 'hasVendorStamp', true, now()),
  ('default', 'Amended Purchase Order', 'hasAuthorizedSignature', true, now()),
  ('default', 'Amended Purchase Order', 'hasVendorStamp', true, now()),
  ('default', 'Invoice', 'hasAuthorizedSignature', true, now()),
  ('default', 'Invoice', 'hasVendorStamp', true, now()),
  ('default', 'Invoice', 'hasStoreStamp', true, now()),
  ('default', 'Invoice', 'hasStoreSignature', true, now()),
  ('default', 'Invoice', 'hasGateStamp', true, now()),
  ('default', 'Tax Invoice', 'hasAuthorizedSignature', true, now()),
  ('default', 'Tax Invoice', 'hasVendorStamp', true, now()),
  ('default', 'Tax Invoice', 'hasStoreStamp', true, now()),
  ('default', 'Tax Invoice', 'hasStoreSignature', true, now()),
  ('default', 'Tax Invoice', 'hasGateStamp', true, now()),
  ('default', 'Delivery Note', 'hasAuthorizedSignature', true, now()),
  ('default', 'Delivery Note', 'hasVendorStamp', true, now()),
  ('default', 'Delivery Note', 'hasStoreStamp', true, now()),
  ('default', 'Delivery Note', 'hasStoreSignature', true, now()),
  ('default', 'Delivery Note', 'hasGateStamp', true, now()),
  ('default', 'Delivery Challan', 'hasAuthorizedSignature', true, now()),
  ('default', 'Delivery Challan', 'hasVendorStamp', true, now()),
  ('default', 'Delivery Challan', 'hasStoreStamp', true, now()),
  ('default', 'Delivery Challan', 'hasStoreSignature', true, now()),
  ('default', 'Delivery Challan', 'hasGateStamp', true, now()),
  ('default', 'Weighment Slip', 'hasAuthorizedSignature', true, now()),
  ('default', 'Lorry Receipt', 'hasAuthorizedSignature', true, now())
on conflict (organization_id, doc_type, field_key) do nothing;
