-- Kalika only; unapplied. No existing organization is modified automatically.
begin;
create function public.access_initialize_organization_settings(p_org text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare table_name text;columns text;projection text;rows_added bigint;result jsonb:='{}';
begin
 perform 1 from public.access_organizations where id=p_org for update;
 if not found then raise exception 'Organization unavailable' using errcode='42501';end if;
 foreach table_name in array array['field_settings','doc_type_settings','comparison_field_groups','purchase_accounting_settings'] loop
  if to_regclass('public.'||table_name) is null then
   result:=result||jsonb_build_object(table_name,'optional table absent');continue;
  end if;
  -- Copy the currently installed schema's configuration columns, including
  -- newer validation fields. Generate fresh IDs/timestamps, never copy identity.
  select string_agg(format('%I',a.attname),',' order by a.attnum),
   string_agg(case when a.attname='organization_id' then '$1' else format('source.%I',a.attname) end,',' order by a.attnum)
   into columns,projection from pg_attribute a
   where a.attrelid=to_regclass('public.'||table_name) and a.attnum>0 and not a.attisdropped
    and a.attgenerated='' and a.attidentity='' and a.attname not in ('id','created_at','updated_at');
  if not exists(select 1 from pg_attribute where attrelid=to_regclass('public.'||table_name) and attname='organization_id' and not attisdropped) then
   raise exception 'Settings table % lacks organization scope',table_name using errcode='23514';
  end if;
  execute format('insert into public.%1$I (%2$s) select %3$s from public.%1$I source where source.organization_id=''default'' on conflict do nothing',table_name,columns,projection) using p_org;
  get diagnostics rows_added=row_count;
  result:=result||jsonb_build_object(table_name,rows_added);
 end loop;
 return result;
end$$;
create function public.access_initialize_new_organization() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
begin perform public.access_initialize_organization_settings(new.id);return new;end$$;
create trigger access_organization_defaults after insert on public.access_organizations
 for each row execute function public.access_initialize_new_organization();
revoke all on function public.access_initialize_organization_settings(text),public.access_initialize_new_organization() from public,anon,authenticated;
grant execute on function public.access_initialize_organization_settings(text),public.access_initialize_new_organization() to service_role;
commit;
