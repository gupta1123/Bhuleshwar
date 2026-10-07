alter table public.packet_cases
add column if not exists owner_user_id uuid references auth.users(id) on delete cascade;

create index if not exists packet_cases_owner_user_id_idx
on public.packet_cases (owner_user_id);

drop policy if exists "packet_cases_owner_select" on public.packet_cases;
create policy "packet_cases_owner_select"
on public.packet_cases
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "packet_cases_owner_insert" on public.packet_cases;
create policy "packet_cases_owner_insert"
on public.packet_cases
for insert
to authenticated
with check (owner_user_id = auth.uid());

drop policy if exists "packet_cases_owner_update" on public.packet_cases;
create policy "packet_cases_owner_update"
on public.packet_cases
for update
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

drop policy if exists "packet_cases_owner_delete" on public.packet_cases;
create policy "packet_cases_owner_delete"
on public.packet_cases
for delete
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "packet_case_files_owner_select" on public.packet_case_files;
create policy "packet_case_files_owner_select"
on public.packet_case_files
for select
to authenticated
using (
  exists (
    select 1
    from public.packet_cases
    where public.packet_cases.id = packet_case_files.case_id
      and public.packet_cases.owner_user_id = auth.uid()
  )
);

drop policy if exists "packet_documents_owner_select" on public.packet_documents;
create policy "packet_documents_owner_select"
on public.packet_documents
for select
to authenticated
using (
  exists (
    select 1
    from public.packet_cases
    where public.packet_cases.id = packet_documents.case_id
      and public.packet_cases.owner_user_id = auth.uid()
  )
);

drop policy if exists "packet_mismatches_owner_select" on public.packet_mismatches;
create policy "packet_mismatches_owner_select"
on public.packet_mismatches
for select
to authenticated
using (
  exists (
    select 1
    from public.packet_cases
    where public.packet_cases.id = packet_mismatches.case_id
      and public.packet_cases.owner_user_id = auth.uid()
  )
);
