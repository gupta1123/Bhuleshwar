alter table public.tally_connections
  add column if not exists control_token_hash text,
  add column if not exists installation_id text,
  add column if not exists bridge_machine_name text,
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_reason text,
  add column if not exists session_generation bigint not null default 0;

-- Recent connector builds temporarily stored the browser control token in the
-- pairing-code column after pairing. Preserve those credentials while
-- separating the two concerns.
update public.tally_connections
set
  control_token_hash = pairing_code_hash,
  pairing_code_hash = null
where bridge_token_hash is not null
  and pairing_code_expires_at is null
  and control_token_hash is null
  and pairing_code_hash is not null;

-- Only UUID-suffixed machine ids were generated from a durable installation
-- identity. Older values such as "MSI-win32-x64" are intentionally not
-- trusted or backfilled.
update public.tally_connections
set installation_id = bridge_machine_id
where installation_id is null
  and bridge_machine_id ~* '-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- If historical data already contains more than one live row for the same
-- installation, retain the freshest heartbeat and revoke the rest before the
-- uniqueness guard is installed.
with ranked as (
  select
    id,
    row_number() over (
      partition by owner_user_id, installation_id
      order by last_heartbeat_at desc nulls last, updated_at desc, created_at desc
    ) as position
  from public.tally_connections
  where installation_id is not null
    and revoked_at is null
    and bridge_token_hash is not null
)
update public.tally_connections as connection
set
  revoked_at = timezone('utc', now()),
  revoked_reason = 'Superseded during connection lifecycle migration.',
  status = 'waiting_for_bridge',
  bridge_token_hash = null,
  control_token_hash = null,
  paired_at = null,
  last_heartbeat_at = null,
  last_tally_reachable = null,
  last_company_loaded = null,
  last_company_name = null,
  last_error = 'Superseded by a newer session for this connector installation.'
from ranked
where connection.id = ranked.id
  and ranked.position > 1;

create index if not exists tally_connections_owner_active_updated_idx
on public.tally_connections (owner_user_id, updated_at desc)
where revoked_at is null;

create index if not exists tally_connections_owner_installation_idx
on public.tally_connections (owner_user_id, installation_id, updated_at desc)
where installation_id is not null;

create unique index if not exists tally_connections_one_live_installation_idx
on public.tally_connections (owner_user_id, installation_id)
where installation_id is not null
  and revoked_at is null
  and bridge_token_hash is not null;
