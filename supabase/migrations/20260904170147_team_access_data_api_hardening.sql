-- Kalika only. Defines preparation/reporting functions; DOES NOT activate sharing
-- or change existing business-object privileges until explicitly invoked during
-- the reviewed activation transaction. Never invoke on another product project.
begin;
set local lock_timeout='5s';

create function public.access_data_api_exposure() returns jsonb
language sql security invoker set search_path=pg_catalog,public as $$
 select jsonb_build_object(
  'relations',coalesce((select jsonb_agg(jsonb_build_object(
    'name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,
    'role',r.name,'privilege',p.name) order by c.relname,r.name,p.name)
   from pg_class c join pg_namespace n on n.oid=c.relnamespace
   cross join (values('anon'),('authenticated')) r(name)
   cross join (values('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(name)
   where n.nspname='public' and c.relkind in ('r','p','v','m','f')
    and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
    and (has_table_privilege(r.name,c.oid,p.name) or
      (p.name in ('SELECT','INSERT','UPDATE','REFERENCES') and has_any_column_privilege(r.name,c.oid,p.name)))),'[]'::jsonb),
  'routines',coalesce((select jsonb_agg(jsonb_build_object(
    'signature',p.oid::regprocedure::text,'securityDefiner',p.prosecdef,'role',r.name) order by p.oid,r.name)
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   cross join (values('anon'),('authenticated')) r(name)
   where n.nspname='public' and p.prokind in ('f','p')
    and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
    and has_function_privilege(r.name,p.oid,'EXECUTE')),'[]'::jsonb));
$$;

create function public.access_harden_data_api(p_confirmation text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare obj record; col record; privilege_name text; before_report jsonb;
begin
 if p_confirmation is distinct from 'KALIKA_REVIEWED_API_ONLY_ACTIVATION' then
  raise exception 'Explicit reviewed Kalika activation confirmation required' using errcode='22023';
 end if;
 -- Invoker must own these objects (migration operator), not an HTTP client.
 before_report:=public.access_data_api_exposure();
 for obj in select c.oid,c.relname,c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p','v','m','f','S')
  and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
 loop
  if obj.relkind='S' then
   foreach privilege_name in array array['USAGE','SELECT','UPDATE'] loop
    if has_sequence_privilege('service_role',obj.oid,privilege_name) then
     execute format('grant %s on sequence public.%I to service_role',privilege_name,obj.relname);
    end if;
   end loop;
   execute format('revoke all on sequence public.%I from public,anon,authenticated',obj.relname);
  else
   -- Preserve existing effective backend privileges that may have come from
   -- PUBLIC; do not grant new privileges such as UPDATE/DELETE on the audit.
   foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
    if has_table_privilege('service_role',obj.oid,privilege_name) then
     execute format('grant %s on table public.%I to service_role',privilege_name,obj.relname);
    end if;
   end loop;
   for col in select attname,attnum from pg_attribute where attrelid=obj.oid and attnum>0 and not attisdropped loop
    foreach privilege_name in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
     if has_column_privilege('service_role',obj.oid,col.attnum,privilege_name) then
      execute format('grant %s (%I) on public.%I to service_role',privilege_name,col.attname,obj.relname);
     end if;
    end loop;
   end loop;
   execute format('revoke all on table public.%I from public,anon,authenticated',obj.relname);
   -- Table REVOKE does not remove column grants. Owner views and materialized
   -- views must also lose grants: table RLS alone does not secure them.
   for col in select attname from pg_attribute where attrelid=obj.oid and attnum>0 and not attisdropped loop
    execute format('revoke select (%1$I),insert (%1$I),update (%1$I),references (%1$I) on public.%2$I from public,anon,authenticated',col.attname,obj.relname);
   end loop;
   if obj.relkind in ('r','p') then execute format('alter table public.%I enable row level security',obj.relname);end if;
  end if;
 end loop;
 for obj in select p.oid,p.prokind from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prokind in ('f','p')
  and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
 loop
  if has_function_privilege('service_role',obj.oid,'EXECUTE') then
   execute format('grant execute on %s %s to service_role',case when obj.prokind='p' then 'procedure' else 'function' end,obj.oid::regprocedure);
  end if;
  execute format('revoke all on %s %s from public,anon,authenticated',case when obj.prokind='p' then 'procedure' else 'function' end,obj.oid::regprocedure);
 end loop;
 -- Restrictive policy defeats existing permissive Storage owner policies.
 -- This does not revoke a previously issued signed URL or a downloaded copy.
 if to_regclass('storage.objects') is not null then
  execute 'alter table storage.objects enable row level security';
  execute 'drop policy if exists kalika_team_api_only on storage.objects';
  execute $policy$create policy kalika_team_api_only on storage.objects as restrictive for all to anon,authenticated
   using (bucket_id not in ('packet-files','bank-statement-files','debit-note-pdfs'))
   with check (bucket_id not in ('packet-files','bank-statement-files','debit-note-pdfs'))$policy$;
 end if;
 if to_regclass('storage.buckets') is not null then
  execute 'update storage.buckets set public=false where id in (''packet-files'',''bank-statement-files'',''debit-note-pdfs'')';
 end if;
 if to_regclass('realtime.messages') is not null and to_regprocedure('realtime.topic()') is not null then
  execute 'drop policy if exists kalika_access_broker_only on realtime.messages';
  execute $policy$create policy kalika_access_broker_only on realtime.messages as restrictive for all to anon,authenticated
   using (coalesce(realtime.topic(),'') not like 'access:%' and coalesce(realtime.topic(),'') not like 'bank-jobs:%')
   with check (coalesce(realtime.topic(),'') not like 'access:%' and coalesce(realtime.topic(),'') not like 'bank-jobs:%')$policy$;
 end if;
 -- PUBLIC schema is application-owned. Auth/Realtime/extension schemas are not
 -- touched. Future migrations must explicitly grant only reviewed authority.
 execute 'revoke create on schema public from public,anon,authenticated';
 execute 'alter default privileges in schema public revoke all on tables from public,anon,authenticated';
 execute 'alter default privileges in schema public revoke all on sequences from public,anon,authenticated';
 -- PostgreSQL's built-in PUBLIC EXECUTE default is global: a schema-level
 -- revoke cannot undo it. This applies to functions created by this migration
 -- role only; explicit grants in Auth/extension migrations remain possible.
 execute 'alter default privileges revoke execute on functions from public,anon,authenticated';
 execute 'alter default privileges in schema public revoke execute on functions from public,anon,authenticated';
 if public.access_data_api_exposure()<>jsonb_build_object('relations','[]'::jsonb,'routines','[]'::jsonb) then
  raise exception 'Inherited client privileges remain; activation aborted' using errcode='42501';
 end if;
 return before_report;
end;
$$;
revoke all on function public.access_data_api_exposure(),public.access_harden_data_api(text) from public,anon,authenticated;
grant execute on function public.access_data_api_exposure() to service_role;
-- Hardening is intentionally migration-owner only. Even the backend cannot call it.
revoke all on function public.access_harden_data_api(text) from service_role;
commit;
