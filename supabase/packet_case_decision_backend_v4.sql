alter table public.packet_cases
drop constraint if exists packet_cases_status_check;

alter table public.packet_cases
add constraint packet_cases_status_check
check (status in ('draft', 'processing', 'completed', 'accepted', 'rejected', 'failed'));

create index if not exists packet_cases_owner_user_status_idx
on public.packet_cases (owner_user_id, status);
