-- GST purchase reconciliation. Apply manually before deploying the API.
-- Every table is server-authorized only: RLS on, no anon/authenticated access.
-- Access checks (organization, role) happen in the API; this file only stores data.
--
-- Sandbox (sandbox.co.in) credentials are shared by the platform and live in the
-- API environment, not in these tables. Per-client rows hold the client's GSTIN
-- and GST session only.

-- ---------------------------------------------------------------------------
-- A. GST access and the portal-data cache
-- ---------------------------------------------------------------------------

-- Shared Sandbox access token, so one auth call serves every client. Single row.
create table public.gst_platform_tokens (
  id smallint primary key default 1 check (id = 1),
  access_token_enc text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- One row per client GSTIN: who it belongs to and the live GST portal session.
create table public.gst_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  company_key text not null,
  gstin text not null check (gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$'),
  gst_username text not null check (length(gst_username) between 1 and 80),
  status text not null default 'needs_otp'
    check (status in ('needs_otp', 'otp_sent', 'active', 'expired', 'error')),
  session_token_enc text,
  session_expiry timestamptz,
  token_expiry timestamptz,
  verified_at timestamptz,
  last_error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, gstin)
);
create index gst_connections_company_idx on public.gst_connections (organization_id, company_key);

-- Saved portal returns. The latest copy per return, period and section; the app
-- reads this and calls the portal only when a row is missing or Refresh is pressed.
create table public.gst_return_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  gstin text not null,
  return_type text not null check (return_type in ('gstr2a', 'gstr2b', 'gstr3b')),
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  section text not null default 'all',
  payload jsonb not null,
  portal_checksum text,
  transaction_id text,
  is_final boolean not null default false,
  fetched_at timestamptz not null default now(),
  fetched_by uuid references auth.users(id) on delete set null,
  fetch_count integer not null default 1,
  unique (organization_id, gstin, return_type, period, section)
);

-- Every call made to the portal, for caps, cost and audit.
create table public.gst_api_calls (
  id bigint generated always as identity primary key,
  organization_id text not null,
  gstin text,
  endpoint text not null,
  return_type text,
  period text,
  requested_by uuid references auth.users(id) on delete set null,
  ok boolean not null,
  http_status integer,
  transaction_id text,
  error text,
  created_at timestamptz not null default now()
);
create index gst_api_calls_org_day_idx on public.gst_api_calls (organization_id, created_at desc);

-- ---------------------------------------------------------------------------
-- B. Purchase register copied from Tally by the connector
-- ---------------------------------------------------------------------------

create table public.tally_books_snapshots (
  organization_id text not null,
  company_key text not null,
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  payload jsonb not null,
  voucher_count integer not null default 0,
  payload_hash text,
  connection_id uuid,
  command_id uuid,
  fetched_at timestamptz not null default now(),
  primary key (organization_id, company_key, period)
);

-- ---------------------------------------------------------------------------
-- C. Suppliers (shared across clients; GSTIN is public portal data)
-- ---------------------------------------------------------------------------

create table public.supplier_profiles (
  gstin text primary key,
  legal_name text,
  trade_name text,
  status text,
  cancellation_date date,
  taxpayer_type text,
  constitution text,
  state_code text,
  address jsonb,
  filing_frequency text check (filing_frequency in ('monthly', 'quarterly')),
  raw jsonb,
  source text not null default 'portal',
  verified_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- D. Reconciliation runs, results and decisions
-- ---------------------------------------------------------------------------

create table public.gst_recon_settings (
  organization_id text not null,
  company_key text not null,
  settings jsonb not null default '{}'::jsonb,
  daily_call_cap integer not null default 100 check (daily_call_cap >= 0),
  min_refresh_minutes integer not null default 60 check (min_refresh_minutes >= 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, company_key)
);

create table public.gst_recon_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  company_key text not null,
  gstin text not null,
  periods text[] not null,
  settings jsonb not null default '{}'::jsonb,
  totals jsonb not null default '{}'::jsonb,
  data_versions jsonb not null default '{}'::jsonb,
  books_as_of timestamptz,
  status text not null default 'complete' check (status in ('running', 'complete', 'failed')),
  error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index gst_recon_runs_company_idx on public.gst_recon_runs (organization_id, company_key, created_at desc);

create table public.gst_recon_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.gst_recon_runs(id) on delete cascade,
  organization_id text not null,
  item_key text not null,
  period text,
  supplier_gstin text,
  invoice_no text,
  invoice_date date,
  doc_type text,
  bucket text not null,
  flags jsonb not null default '[]'::jsonb,
  reason text,
  match_type text,
  itc_at_risk numeric(16, 2) not null default 0,
  books jsonb,
  g2b jsonb,
  g2a jsonb
);
create index gst_recon_items_run_idx on public.gst_recon_items (run_id);
create index gst_recon_items_key_idx on public.gst_recon_items (organization_id, item_key);

-- Append-only: the newest row per item_key is the current decision.
create table public.gst_recon_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null,
  company_key text not null,
  item_key text not null,
  run_id uuid references public.gst_recon_runs(id) on delete set null,
  decision text not null check (decision in ('hold', 'chase_supplier', 'accept', 'reject', 'book_it', 'reopen')),
  note text check (length(note) <= 1000),
  decided_by uuid references auth.users(id) on delete set null,
  decided_by_name text,
  decided_at timestamptz not null default now()
);
create index gst_recon_decisions_key_idx
  on public.gst_recon_decisions (organization_id, company_key, item_key, decided_at desc);

-- ---------------------------------------------------------------------------
-- Security: server only
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'gst_platform_tokens', 'gst_connections', 'gst_return_snapshots', 'gst_api_calls',
    'tally_books_snapshots', 'supplier_profiles',
    'gst_recon_settings', 'gst_recon_runs', 'gst_recon_items', 'gst_recon_decisions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;
grant usage, select on sequence public.gst_api_calls_id_seq to service_role;

comment on table public.gst_connections is
  'Client GSTIN plus the live GST portal session. Tokens are encrypted by the API before storage.';
comment on table public.gst_return_snapshots is
  'Latest saved copy of each portal return. Read first; the portal is called only on a miss or an explicit Refresh.';
comment on table public.tally_books_snapshots is
  'Purchase register read from Tally by the local agent, so the app works while the Tally PC is off.';
comment on table public.supplier_profiles is
  'Public taxpayer details per supplier GSTIN, refreshed rarely (status, composition, filing frequency).';
