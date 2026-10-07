-- Prevent exact duplicate packet uploads for the same owner.
-- The application writes processing_meta.uploadFingerprint from a sorted SHA-256
-- file-content signature, so file order does not affect duplicate detection.

create unique index if not exists packet_cases_owner_upload_fingerprint_unique_idx
on public.packet_cases (owner_user_id, (processing_meta->>'uploadFingerprint'))
where nullif(processing_meta->>'uploadFingerprint', '') is not null;
