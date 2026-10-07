-- Speeds up draft append, case detail loads, mismatch review, and worker job claiming.
-- These are additive and safe to run multiple times.

create index if not exists packet_case_files_case_id_original_name_idx
on public.packet_case_files (case_id, original_name);

create index if not exists packet_case_files_case_id_created_id_idx
on public.packet_case_files (case_id, created_at, id);

create index if not exists packet_documents_case_id_source_file_created_idx
on public.packet_documents (case_id, source_file_name, created_at);

create index if not exists packet_documents_case_id_type_created_idx
on public.packet_documents (case_id, document_type, created_at);

create index if not exists packet_mismatches_case_id_field_name_idx
on public.packet_mismatches (case_id, field_name);

create index if not exists packet_processing_jobs_queued_claim_idx
on public.packet_processing_jobs (next_run_at, created_at)
where status = 'queued';

create index if not exists packet_cases_owner_status_created_idx
on public.packet_cases (owner_user_id, status, created_at desc);
