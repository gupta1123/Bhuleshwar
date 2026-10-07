-- Kalika only. Does not activate sharing or change existing records.
begin;
create function public.access_enqueue_agent_sync(
 p_actor uuid,p_org text,p_company uuid,p_connection uuid,p_installation text,
 p_generation bigint,p_owner uuid,p_guid text,p_year text,p_type text,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare c record; l record; cmd record; identity jsonb; company_name text;
begin
 if p_type is null or p_type not in ('agent_sync_dataset','agent_reconcile_dataset')
  or p_payload is distinct from '{}'::jsonb then
  raise exception 'Only selected-dataset sync is supported' using errcode='22023';
 end if;
 perform 1 from public.access_organizations where id=p_org for update;
 perform public.access_assert_permission(p_actor,p_org,'connections.manage',p_company);
 select * into c from public.tally_connections where id=p_connection for share;
 if not found or c.revoked_at is not null or c.owner_user_id is distinct from p_owner
  or c.installation_id is distinct from p_installation or c.session_generation is distinct from p_generation then
  raise exception 'Pairing changed' using errcode='42501';
 end if;
 select * into l from public.access_company_links where organization_id=p_org and company_id=p_company
  and connection_id=p_connection and installation_id=p_installation and company_guid=p_guid and financial_year=p_year for share;
 if not found then raise exception 'Verified dataset required' using errcode='42501';end if;
 select name into company_name from public.access_companies where organization_id=p_org and id=p_company;
 identity:=jsonb_build_object('protocolVersion',1,'organizationId',p_org,'ownerUserId',c.owner_user_id,
  'connectionId',c.id,'installationId',p_installation,'sessionGeneration',p_generation,
  'companyGuid',p_guid,'companyName',company_name,'financialYear',p_year);
 insert into public.tally_bridge_commands(connection_id,owner_user_id,organization_id,installation_id,session_generation,
  company_guid,financial_year,command_type,status,priority,payload,protocol_version,job_class,max_attempts,deadline_at)
 values(c.id,c.owner_user_id,p_org,p_installation,p_generation,p_guid,p_year,p_type,'queued',40,
  jsonb_build_object('agentIdentity',identity),1,'incremental_sync',1,now()+interval '15 minutes') returning * into cmd;
 insert into public.access_command_authority(command_id,organization_id,company_id,initiating_user_id,permission)
 values(cmd.id,p_org,p_company,p_actor,'connections.manage');
 return to_jsonb(cmd);
end $$;
revoke all on function public.access_enqueue_agent_sync(uuid,text,uuid,uuid,text,bigint,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.access_enqueue_agent_sync(uuid,text,uuid,uuid,text,bigint,uuid,text,text,text,jsonb) to service_role;
commit;
