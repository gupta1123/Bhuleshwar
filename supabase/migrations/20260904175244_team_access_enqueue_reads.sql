-- Additive, unapplied. Shared read jobs retain the connector owner's transport
-- identity while recording the actual user who requested the operation.
begin;
create function public.access_enqueue_read(p_actor uuid,p_org text,p_company uuid,
 p_connection uuid,p_installation text,p_generation bigint,p_guid text,p_year text,
 p_type text,p_payload jsonb) returns jsonb language plpgsql security invoker
set search_path=pg_catalog,public as $$
declare permission text; c record; cmd record; company_name text;
begin
 permission:=case p_type when 'fetch_bank_ledgers' then 'bank.prepare'
  when 'fetch_purchase_masters' then 'purchases.prepare'
  when 'fetch_customer_open_bills' then 'discounts.prepare' end;
 if permission is null then raise exception 'Unsupported shared read command' using errcode='42501';end if;
 if jsonb_typeof(p_payload) is distinct from 'object' or pg_column_size(p_payload)>1048576 then
  raise exception 'Invalid read payload' using errcode='22023';end if;
 perform 1 from public.access_organizations where id=p_org for update;
 perform public.access_assert_permission(p_actor,p_org,permission,p_company);
 select * into c from public.tally_connections where id=p_connection for share;
 if not found or c.revoked_at is not null or c.installation_id is distinct from p_installation
  or c.session_generation is distinct from p_generation then raise exception 'Pairing changed' using errcode='42501';end if;
 perform 1 from public.access_company_links where organization_id=p_org and company_id=p_company
  and connection_id=p_connection and installation_id=p_installation and company_guid=p_guid and financial_year=p_year for share;
 if not found then raise exception 'Verified company mapping required' using errcode='42501';end if;
 select name into company_name from public.access_companies where organization_id=p_org and id=p_company;
 if p_payload->>'companyName' is distinct from company_name then raise exception 'Company selection changed' using errcode='42501';end if;
 if p_payload ? 'companyNames' and p_payload->'companyNames' is distinct from jsonb_build_array(company_name) then
  raise exception 'Multi-company reads require separate authorized jobs' using errcode='42501';end if;
 insert into public.tally_bridge_commands(connection_id,owner_user_id,organization_id,installation_id,session_generation,
  company_guid,financial_year,command_type,status,priority,payload,protocol_version,job_class,max_attempts,deadline_at)
 values(c.id,c.owner_user_id,p_org,p_installation,p_generation,p_guid,p_year,p_type,'queued',25,
  p_payload||jsonb_build_object('companyGuid',p_guid,'financialYear',p_year),1,'tally_read',1,now()+interval '5 minutes') returning * into cmd;
 insert into public.access_command_authority(command_id,organization_id,company_id,initiating_user_id,permission)
 values(cmd.id,p_org,p_company,p_actor,permission);
 return to_jsonb(cmd);
end $$;
revoke all on function public.access_enqueue_read(uuid,text,uuid,uuid,text,bigint,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.access_enqueue_read(uuid,text,uuid,uuid,text,bigint,text,text,text,jsonb) to service_role;
commit;
