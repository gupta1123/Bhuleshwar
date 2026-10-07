alter table public.packet_mismatches
add column if not exists resolution_status text not null default 'pending';

alter table public.packet_mismatches
add column if not exists resolved_at timestamptz;

update public.packet_mismatches
set resolution_status = 'pending'
where resolution_status is null;

alter table public.packet_mismatches
drop constraint if exists packet_mismatches_resolution_status_check;

alter table public.packet_mismatches
add constraint packet_mismatches_resolution_status_check
check (resolution_status in ('pending', 'accepted', 'rejected'));

create index if not exists packet_mismatches_case_id_resolution_status_idx
on public.packet_mismatches (case_id, resolution_status);
