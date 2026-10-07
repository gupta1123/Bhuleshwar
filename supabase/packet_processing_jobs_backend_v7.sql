create table if not exists public.packet_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.packet_cases(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  job_type text not null default 'case_analysis',
  status text not null default 'queued',
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  progress integer not null default 0,
  stage text,
  error text,
  result jsonb not null default '{}'::jsonb,
  locked_at timestamptz,
  locked_by text,
  next_run_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint packet_processing_jobs_status_check
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);

create index if not exists packet_processing_jobs_status_next_run_idx
on public.packet_processing_jobs (status, next_run_at);

create index if not exists packet_processing_jobs_case_created_idx
on public.packet_processing_jobs (case_id, created_at desc);

create index if not exists packet_processing_jobs_owner_created_idx
on public.packet_processing_jobs (owner_user_id, created_at desc);

alter table public.packet_processing_jobs enable row level security;

drop policy if exists "packet_processing_jobs_owner_select" on public.packet_processing_jobs;
create policy "packet_processing_jobs_owner_select"
on public.packet_processing_jobs
for select
to authenticated
using (
  exists (
    select 1
    from public.packet_cases
    where public.packet_cases.id = packet_processing_jobs.case_id
      and public.packet_cases.owner_user_id = auth.uid()
  )
);

drop trigger if exists set_packet_processing_jobs_updated_at on public.packet_processing_jobs;
create trigger set_packet_processing_jobs_updated_at
before update on public.packet_processing_jobs
for each row
execute function public.set_updated_at();

create or replace function public.claim_packet_processing_job(worker_name text default 'worker')
returns public.packet_processing_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.packet_processing_jobs;
begin
  select *
  into claimed
  from public.packet_processing_jobs
  where status = 'queued'
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
