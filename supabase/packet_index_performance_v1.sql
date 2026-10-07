-- Index-only performance migration for the current packet workflow.
-- This file is additive only: no table changes, no policy changes, no data changes.
--
-- Rationale:
-- 1. packet case listing queries filter by owner_user_id and sort by created_at desc
-- 2. case detail queries load child rows by case_id and sort by created_at
-- 3. recycle-bin deleted-case queries are already covered by packet_recycle_bin_backend_v3.sql

create index if not exists packet_cases_owner_user_created_at_idx
on public.packet_cases (owner_user_id, created_at desc);

create index if not exists packet_case_files_case_id_created_at_idx
on public.packet_case_files (case_id, created_at);

create index if not exists packet_documents_case_id_created_at_idx
on public.packet_documents (case_id, created_at);

create index if not exists packet_mismatches_case_id_created_at_idx
on public.packet_mismatches (case_id, created_at);
