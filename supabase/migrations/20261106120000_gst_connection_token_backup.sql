-- Keep the GST session token that was in place before the latest refresh. If a bad write or a failed
-- refresh ever replaces the live token, the previous one is still in the row and can be put back.
alter table public.gst_connections
  add column if not exists prev_session_token_enc text,
  add column if not exists prev_token_expiry timestamptz,
  add column if not exists prev_token_saved_at timestamptz;
