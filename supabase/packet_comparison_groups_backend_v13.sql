create extension if not exists pgcrypto;

create table if not exists public.comparison_field_groups (
  id uuid default gen_random_uuid() primary key,
  organization_id text default 'default',
  group_key text not null,
  label text not null,
  fields jsonb not null default '[]'::jsonb,
  enabled boolean default true,
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (organization_id, group_key)
);

create index if not exists comparison_field_groups_org_sort_idx
  on public.comparison_field_groups (organization_id, sort_order, label);

insert into public.comparison_field_groups (
  organization_id,
  group_key,
  label,
  fields,
  enabled,
  sort_order,
  updated_at
)
values
  (
    'default',
    'commercial_amounts',
    'Commercial / Amounts',
    '["subtotal", "taxAmount", "totalAmount", "paidAmount", "statementAmount", "currency"]'::jsonb,
    true,
    10,
    now()
  ),
  (
    'default',
    'party_identity',
    'Party / Identity Details',
    '["vendorName", "supplierGstin", "buyerName", "buyerGstin", "ownerName", "driverName", "holderName", "fatherName", "panNumber"]'::jsonb,
    true,
    20,
    now()
  ),
  (
    'default',
    'weight_quantity',
    'Weight / Quantity',
    '["grossWeight", "tareWeight", "netWeight", "itemQuantity", "unit"]'::jsonb,
    true,
    30,
    now()
  ),
  (
    'default',
    'references',
    'Document References',
    '["poNumber", "referencePoNumber", "invoiceNumber", "referenceInvoiceNumber", "receiptNumber"]'::jsonb,
    true,
    40,
    now()
  ),
  (
    'default',
    'vehicle_logistics',
    'Vehicle / Logistics',
    '["vehicleNumber", "registrationNumber", "lorryReceiptNumber", "fastagReference", "eWayBillNumber"]'::jsonb,
    true,
    50,
    now()
  )
on conflict (organization_id, group_key) do nothing;
