-- Connector builds before 0.1.32 did not have a durable installation identity
-- or safe cross-browser disconnect semantics. They must pair again once so the
-- browser, API, and connector all agree on the same managed session.
update public.tally_connections
set
  revoked_at = timezone('utc', now()),
  revoked_reason = 'Legacy connector session requires one-time reconnect.',
  status = 'waiting_for_bridge',
  bridge_token_hash = null,
  control_token_hash = null,
  paired_at = null,
  last_heartbeat_at = null,
  last_tested_at = null,
  last_tally_reachable = null,
  last_company_loaded = null,
  last_company_name = null,
  last_error = 'Install connector 0.1.32 or newer and reconnect.'
where revoked_at is null
  and bridge_token_hash is not null
  and (
    installation_id is null
    or bridge_machine_id is null
    or bridge_machine_id !~* '-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or case
      when coalesce(bridge_version, '') ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
        then (
          split_part(bridge_version, '.', 1)::integer,
          split_part(bridge_version, '.', 2)::integer,
          split_part(bridge_version, '.', 3)::integer
        ) < (0, 1, 32)
      else true
    end
  );

update public.tally_bridge_commands as command
set
  status = 'canceled',
  error = 'Connector session was retired during the 0.1.32 lifecycle upgrade.',
  completed_at = coalesce(command.completed_at, timezone('utc', now())),
  updated_at = timezone('utc', now())
from public.tally_connections as connection
where command.connection_id = connection.id
  and connection.revoked_reason = 'Legacy connector session requires one-time reconnect.'
  and command.status in ('queued', 'claimed');

-- Unfinished browser pairing attempts are drafts, not workstations. Retire
-- expired drafts so they cannot accumulate or appear as connector sessions.
update public.tally_connections
set
  revoked_at = timezone('utc', now()),
  revoked_reason = 'Expired connector pairing attempt.',
  pairing_code_hash = null,
  pairing_code_expires_at = null,
  last_error = 'Pairing attempt expired. Start a new connection when ready.',
  updated_at = timezone('utc', now())
where revoked_at is null
  and bridge_token_hash is null
  and (
    pairing_code_expires_at is null
    or pairing_code_expires_at <= timezone('utc', now())
  );
