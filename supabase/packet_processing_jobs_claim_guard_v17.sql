drop function if exists public.claim_packet_processing_job(text);
drop function if exists public.claim_packet_processing_job(text, interval);

create or replace function public.claim_packet_processing_job(
  worker_name text default 'worker',
  stale_after interval default interval '20 minutes'
)
returns public.packet_processing_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.packet_processing_jobs;
begin
  with exhausted as (
    update public.packet_processing_jobs
    set status = 'failed',
        progress = 100,
        stage = 'Failed',
        error = coalesce(error, 'Processing exceeded retry limit.'),
        locked_at = null,
        locked_by = null,
        finished_at = coalesce(finished_at, now()),
        updated_at = now()
    where status = 'queued'
      and attempt_count >= max_attempts
    returning case_id, error
  )
  update public.packet_cases cases
  set status = 'failed',
      processing_meta = coalesce(cases.processing_meta, '{}'::jsonb) || jsonb_build_object(
        'lastProcessingError',
        coalesce(exhausted.error, 'Processing exceeded retry limit.')
      )
  from exhausted
  where cases.id = exhausted.case_id;

  with stale as (
    update public.packet_processing_jobs
    set status = case
          when attempt_count >= max_attempts then 'failed'
          else 'queued'
        end,
        progress = case
          when attempt_count >= max_attempts then 100
          else 0
        end,
        stage = case
          when attempt_count >= max_attempts then 'Failed'
          else 'Queued after stale worker run'
        end,
        error = coalesce(error, 'Processing run became stale.'),
        locked_at = null,
        locked_by = null,
        next_run_at = now(),
        finished_at = case
          when attempt_count >= max_attempts then coalesce(finished_at, now())
          else finished_at
        end,
        updated_at = now()
    where status = 'running'
      and locked_at is not null
      and locked_at < now() - stale_after
    returning case_id, status, error
  )
  update public.packet_cases cases
  set status = 'failed',
      processing_meta = coalesce(cases.processing_meta, '{}'::jsonb) || jsonb_build_object(
        'lastProcessingError',
        coalesce(stale.error, 'Processing run became stale.')
      )
  from stale
  where cases.id = stale.case_id
    and stale.status = 'failed';

  select *
  into claimed
  from public.packet_processing_jobs
  where status = 'queued'
    and attempt_count < max_attempts
    and next_run_at <= now()
  order by created_at asc
  for update skip locked
  limit 1;

  if claimed.id is null then
    return null;
  end if;

  update public.packet_processing_jobs
  set status = 'running',
      attempt_count = claimed.attempt_count + 1,
      locked_at = now(),
      locked_by = worker_name,
      started_at = coalesce(claimed.started_at, now()),
      updated_at = now()
  where id = claimed.id
  returning *
  into claimed;

  return claimed;
end;
$$;
