-- Unapplied, Kalika only. Atomically register newly created scoped business rows.
-- Historical records remain unmapped until the reviewed mapping operation is used.
begin;
create function public.access_register_created_resource() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare row_data jsonb:=to_jsonb(new);org text;company uuid;actor uuid;kind text;permission text;
begin
 org:=row_data->>'access_organization_id';company:=(row_data->>'access_company_id')::uuid;
 if org is null and company is null then return new;end if;
 if org is null or company is null then raise exception 'Complete organization and company scope required' using errcode='23514';end if;
 kind:=case tg_table_name when 'packet_cases' then 'case' when 'bank_statement_imports' then 'bank_import' when 'bank_accounts' then 'bank_account' when 'debit_note_proposals' then 'proposal' end;
 permission:=case kind when 'case' then 'purchases.prepare' when 'bank_import' then 'bank.prepare' when 'bank_account' then 'bank.prepare' when 'proposal' then 'discounts.prepare' end;
 if kind is null then raise exception 'Unsupported resource registration' using errcode='22023';end if;
 actor:=(row_data->>'owner_user_id')::uuid;
 perform 1 from public.access_organizations where id=org for update;
 perform public.access_assert_permission(actor,org,permission,company);
 insert into public.access_resource_scopes(resource_type,resource_id,organization_id,company_id,creator_user_id,mapping_evidence)
 values(kind,(row_data->>'id')::uuid,org,company,actor,'Explicit company selection at authenticated resource creation');
 return new;
end $$;
do $$ declare t text;begin
 foreach t in array array['packet_cases','bank_statement_imports','bank_accounts','debit_note_proposals'] loop
  if to_regclass('public.'||t) is not null then execute format('create trigger access_register_resource after insert on public.%I for each row execute function public.access_register_created_resource()',t);end if;
 end loop;
end $$;
revoke all on function public.access_register_created_resource() from public,anon,authenticated;
grant execute on function public.access_register_created_resource() to service_role;
commit;
