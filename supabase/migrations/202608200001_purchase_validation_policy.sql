-- Organization-level severity controls for non-structural Purchase posting checks.
-- This migration is intentionally safe for the existing backend-only settings table.

alter table public.purchase_accounting_settings
  add column if not exists validation_policy jsonb not null default
  '{
    "companyGstinMissing": "warn",
    "companyGstinInvalid": "warn",
    "buyerGstinMissing": "warn",
    "supplierGstinMissing": "warn",
    "buyerCompanyGstinMismatch": "block",
    "supplierLedgerGstinMismatch": "block",
    "hsnMissing": "warn",
    "stockItemHsnMismatch": "warn",
    "stockItemUnitMismatch": "warn",
    "sourceDocumentMissing": "warn",
    "caseNotAccepted": "block",
    "staleTallyMasters": "warn",
    "possibleDuplicate": "block"
  }'::jsonb;

alter table public.purchase_accounting_settings
  drop constraint if exists purchase_accounting_settings_validation_policy_object;

alter table public.purchase_accounting_settings
  add constraint purchase_accounting_settings_validation_policy_object
  check (jsonb_typeof(validation_policy) = 'object');

comment on column public.purchase_accounting_settings.validation_policy is
  'Per-rule Purchase posting severity: block, warn, or off. Structural accounting checks remain mandatory.';
