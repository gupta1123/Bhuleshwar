-- Draft cleanup must not orphan authorization mappings. ERP/audit history is
-- retained; this is not an activation or historical backfill migration.
begin;
create function public.access_guard_resource_deletion() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare kind text:=tg_argv[0]; protected_posting boolean:=false;
begin
 if not exists(select 1 from public.access_resource_scopes where resource_type=kind and resource_id=old.id) then return old;end if;
 if kind='case' and to_regclass('public.purchase_invoice_tally_postings') is not null then
  execute 'select exists(select 1 from public.purchase_invoice_tally_postings where case_id=$1 and status in (''queued'',''creating'',''created'',''verification_required''))' into protected_posting using old.id;
 end if;
 if kind='case' and (protected_posting or exists(select 1 from public.access_purchase_workflows where case_id=old.id and state<>'draft')
   or exists(select 1 from public.access_command_authority where case_id=old.id)) then
   raise exception 'Keep the purchase and its approval or ERP history; recycle it instead' using errcode='55000';
 end if;
 return old;
end $$;
create function public.access_cleanup_deleted_resource() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare kind text:=tg_argv[0];
begin
 if kind='case' then delete from public.access_purchase_workflows where case_id=old.id and state='draft';end if;
 delete from public.access_resource_scopes where resource_type=kind and resource_id=old.id;
 return old;
end $$;
do $$ declare mapping text[];begin
 foreach mapping slice 1 in array array[['packet_cases','case'],['bank_statement_imports','bank_import'],['bank_accounts','bank_account'],['debit_note_proposals','proposal']] loop
  if to_regclass('public.'||mapping[1]) is not null then
   execute format('create trigger access_guard_resource_deletion before delete on public.%I for each row execute function public.access_guard_resource_deletion(%L)',mapping[1],mapping[2]);
   execute format('create trigger access_cleanup_deleted_resource after delete on public.%I for each row execute function public.access_cleanup_deleted_resource(%L)',mapping[1],mapping[2]);
  end if;
 end loop;
end $$;
-- Files and mismatch corrections are also inputs to a submitted purchase.
-- Protect the child-table paths used by uploads, reanalysis and correction APIs.
do $$ declare table_name text;begin
 foreach table_name in array array['packet_case_files','packet_mismatches'] loop
  if to_regclass('public.'||table_name) is not null then
   execute format('create trigger access_financial_edit before insert or update or delete on public.%I for each row execute function public.access_guard_purchase_edit()',table_name);
  end if;
 end loop;
end $$;
revoke all on function public.access_guard_resource_deletion(),public.access_cleanup_deleted_resource() from public,anon,authenticated;
grant execute on function public.access_guard_resource_deletion(),public.access_cleanup_deleted_resource() to service_role;
commit;
