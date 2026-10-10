-- Cash Discount open-bill scans now travel through the authenticated live
-- gateway and must not remain in Postgres. Preserve only a non-sensitive
-- transport marker on historical command rows so operational timing records
-- remain intelligible.
update public.tally_bridge_commands
set
  status = case when status in ('queued', 'claimed') then 'canceled' else status end,
  payload = jsonb_build_object('transport', 'retired_cash_discount_database_scan'),
  result = '{}'::jsonb,
  error = case
    when status in ('queued', 'claimed') then 'Canceled because Cash Discounts now uses the live in-memory connector channel.'
    else error
  end,
  completed_at = case
    when status in ('queued', 'claimed') then coalesce(completed_at, now())
    else completed_at
  end
where command_type = 'fetch_customer_open_bills'
  and (payload ? 'scanId' or payload ? 'scanComplete');
