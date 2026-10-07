alter table public.packet_cases
add column if not exists deleted_at timestamptz;

alter table public.packet_cases
add column if not exists deleted_by_user_id uuid references auth.users(id) on delete set null;

create index if not exists packet_cases_deleted_at_idx
on public.packet_cases (deleted_at desc);

create index if not exists packet_cases_owner_user_deleted_at_idx
on public.packet_cases (owner_user_id, deleted_at);
