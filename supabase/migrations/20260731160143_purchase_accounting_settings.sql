-- Client-level purchase voucher rules.
--
-- Core behavior (Maharashtra buyer registration, intra/inter-state GST,
-- M.S./O.M.S. purchase ledgers, freight, round-off, and invoice/voucher dates)
-- is intentionally not configurable. Only deductions whose applicability
-- depends on the buyer's legal/tax profile are stored here.

create table if not exists public.purchase_accounting_settings (
  organization_id text primary key,
  purchase_goods_tds_enabled boolean not null default false,
  transporter_tds_enabled boolean not null default false,
  gst_tds_enabled boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint purchase_accounting_settings_organization_id_check
    check (btrim(organization_id) <> '')
);

comment on table public.purchase_accounting_settings is
  'Organization-level switches for legally conditional purchase-voucher deductions.';
comment on column public.purchase_accounting_settings.purchase_goods_tds_enabled is
  'Allows a confirmed purchase-of-goods TDS deduction; never inferred from HSN or invoice basic value.';
comment on column public.purchase_accounting_settings.transporter_tds_enabled is
  'Allows a confirmed transporter TDS deduction when the reviewed invoice contains it.';
comment on column public.purchase_accounting_settings.gst_tds_enabled is
  'Allows confirmed GST TDS only for an organization that is a notified GST deductor.';

insert into public.purchase_accounting_settings (organization_id)
values ('default')
on conflict (organization_id) do nothing;

alter table public.purchase_accounting_settings enable row level security;

drop trigger if exists set_purchase_accounting_settings_updated_at
  on public.purchase_accounting_settings;
create trigger set_purchase_accounting_settings_updated_at
before update on public.purchase_accounting_settings
for each row execute function public.set_packet_updated_at();

-- Settings are exposed only through authenticated application API routes.
-- Browser clients never access this table directly.
revoke all on table public.purchase_accounting_settings
  from public, anon, authenticated;
grant select, insert, update
  on table public.purchase_accounting_settings
  to service_role;
