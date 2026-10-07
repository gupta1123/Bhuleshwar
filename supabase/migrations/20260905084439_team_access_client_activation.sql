-- Kalika only. Preparation only: applying this file does NOT enable sharing.
-- The migration operator must complete the client-release checklist before
-- invoking activation; HTTP/service-role callers cannot activate it.
begin;
alter table public.access_organizations add column client_release_version integer not null default 0;
alter table public.access_organizations drop constraint access_sharing_requires_enforcement;
alter table public.access_organizations add constraint access_sharing_requires_enforcement
 check(not sharing_enabled or client_release_version=1);

create function public.access_client_release_readiness(p_org text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare missing text[]:='{}';item text;owners integer;companies integer;unmapped bigint;org_exists boolean;
begin
 foreach item in array array['access_snapshot','access_change','access_provision','access_harden_data_api',
 'access_enqueue_purchase','access_complete_purchase_command','access_enqueue_bank_batch','access_complete_bank_command',
 'access_bank_local_create','access_bank_backend_finalize','access_enqueue_discount','access_complete_discount',
 'access_enqueue_master_sync','access_save_master_snapshot','access_enqueue_proposal_operation','access_complete_proposal_operation',
 'access_enqueue_agent_sync'] loop
  if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=item) then missing:=array_append(missing,item);end if;
 end loop;
 select exists(select 1 from public.access_organizations where id=p_org) into org_exists;
 select count(*) into owners from public.access_members where organization_id=p_org and is_owner and status='active';
 select count(*) into companies from public.access_company_links l join public.access_companies c
  on c.id=l.company_id and c.organization_id=l.organization_id where l.organization_id=p_org;
 select count(*) into unmapped from public.access_resource_scopes where organization_id=p_org and company_id is null;
 return jsonb_build_object('releaseVersion',1,'schemaReady',cardinality(missing)=0,'missingFunctions',missing,
  'organizationExists',org_exists,'activeOwners',owners,'verifiedDatasets',companies,'unclassifiedMappedRows',unmapped,
  'activationReady',cardinality(missing)=0 and org_exists and owners>0 and companies>0,
  'note','Historical rows without reviewed mappings remain inaccessible. Review access_mapping_report before activation.');
end $$;

create function public.access_activate_client_release(p_org text,p_revision bigint,p_confirmation text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare readiness jsonb;r bigint;
begin
 if p_confirmation is distinct from 'KALIKA_CLIENT_RELEASE_CODE_AND_MAPPINGS_REVIEWED' then
  raise exception 'Review Kalika project, deployed enforcement and mappings first' using errcode='22023';end if;
 select revision into r from public.access_organizations where id=p_org for update;
 if r is null or r is distinct from p_revision then raise exception 'Organization revision changed' using errcode='40001';end if;
 readiness:=public.access_client_release_readiness(p_org);
 if not coalesce((readiness->>'activationReady')::boolean,false) then
  raise exception 'Client release prerequisites missing: %',readiness using errcode='55000';end if;
 perform public.access_harden_data_api('KALIKA_REVIEWED_API_ONLY_ACTIVATION');
 update public.access_organizations set client_release_version=1,sharing_enabled=true,revision=revision+1 where id=p_org;
 return readiness||jsonb_build_object('activated',true,'revision',r+1);
end $$;
revoke all on function public.access_client_release_readiness(text),public.access_activate_client_release(text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.access_client_release_readiness(text) to service_role;
-- Explicit activation remains database-operator-only. No grants to the backend.
commit;
