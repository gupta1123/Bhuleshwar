-- Kalika only. Additive and unapplied to hosted projects. Does not enable sharing.
begin;
create function public.access_enqueue_agent_read(
 p_actor uuid,p_org text,p_company uuid,p_connection uuid,p_installation text,
 p_generation bigint,p_owner uuid,p_guid text,p_year text,p_type text,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare c record; cmd record; company_name text; identity jsonb; fiscal_start date; fiscal_end date;
begin
 if p_type not in ('agent_query_open_bills','agent_query_workflow_vouchers') or p_type is null then
  raise exception 'Unsupported shared agent read' using errcode='42501';
 end if;
 if jsonb_typeof(p_payload) is distinct from 'object' or pg_column_size(p_payload)>262144
  or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('ledgerNames','dateFrom','dateTo','workflow')) then
  raise exception 'Invalid agent read payload' using errcode='22023';
 end if;
 if jsonb_typeof(p_payload->'ledgerNames') is distinct from 'array' then
  raise exception 'Ledger selection required' using errcode='22023';
 end if;
 if jsonb_array_length(p_payload->'ledgerNames') not between 1 and 250
  or exists(select 1 from jsonb_array_elements(p_payload->'ledgerNames') x
   where jsonb_typeof(x)<>'string' or length(btrim(x#>>'{}')) not between 1 and 500) then
  raise exception 'Invalid ledger selection' using errcode='22023';
 end if;
 if p_type='agent_query_workflow_vouchers' and coalesce(p_payload->>'workflow','') not in ('cash_discount','turnover_discount') then
  raise exception 'Unsupported workflow' using errcode='22023';
 end if;
 if p_year is null or p_year !~ '^20[0-9]{2}-(20[0-9]{2}|[0-9]{2})$' then
  raise exception 'Invalid financial year' using errcode='22023';
 end if;
 fiscal_start:=make_date(left(p_year,4)::int,4,1); fiscal_end:=(fiscal_start+interval '1 year'-interval '1 day')::date;
 if right(p_year,2)::int<>mod(extract(year from fiscal_end)::int,100) then
  raise exception 'Invalid financial year end' using errcode='22023';
 end if;
 if coalesce(p_payload->>'dateFrom','') !~ '^[0-9]{8}$' or coalesce(p_payload->>'dateTo','') !~ '^[0-9]{8}$' then
  raise exception 'Report dates required' using errcode='22023';
 end if;
 if to_char(to_date(p_payload->>'dateFrom','YYYYMMDD'),'YYYYMMDD')<>p_payload->>'dateFrom'
  or to_char(to_date(p_payload->>'dateTo','YYYYMMDD'),'YYYYMMDD')<>p_payload->>'dateTo'
  or to_date(p_payload->>'dateFrom','YYYYMMDD')<fiscal_start
  or to_date(p_payload->>'dateTo','YYYYMMDD')>fiscal_end
  or p_payload->>'dateFrom'>p_payload->>'dateTo' then
  raise exception 'Report dates outside dataset' using errcode='22023';
 end if;
 -- Same lock ordering as role changes and dispatch; no network work in this transaction.
 perform 1 from public.access_organizations where id=p_org for update;
 perform public.access_assert_permission(p_actor,p_org,'discounts.prepare',p_company);
 select * into c from public.tally_connections where id=p_connection for share;
 if not found or c.revoked_at is not null or c.owner_user_id is distinct from p_owner
  or c.installation_id is distinct from p_installation or c.session_generation is distinct from p_generation then
  raise exception 'Pairing changed' using errcode='42501';
 end if;
 perform 1 from public.access_company_links where organization_id=p_org and company_id=p_company
  and connection_id=p_connection and installation_id=p_installation and company_guid=p_guid and financial_year=p_year for share;
 if not found then raise exception 'Verified dataset required' using errcode='42501';end if;
 select name into company_name from public.access_companies where organization_id=p_org and id=p_company;
 identity:=jsonb_build_object('protocolVersion',1,'organizationId',p_org,'ownerUserId',c.owner_user_id,
  'connectionId',c.id,'installationId',p_installation,'sessionGeneration',p_generation,
  'companyGuid',p_guid,'companyName',company_name,'financialYear',p_year);
 insert into public.tally_bridge_commands(connection_id,owner_user_id,organization_id,installation_id,session_generation,
  company_guid,financial_year,command_type,status,priority,payload,protocol_version,job_class,max_attempts,deadline_at)
 values(c.id,c.owner_user_id,p_org,p_installation,p_generation,p_guid,p_year,p_type,'queued',80,
  p_payload||jsonb_build_object('agentIdentity',identity),1,'interactive_read',1,now()+interval '5 minutes') returning * into cmd;
 insert into public.access_command_authority(command_id,organization_id,company_id,initiating_user_id,permission)
 values(cmd.id,p_org,p_company,p_actor,'discounts.prepare');
 return to_jsonb(cmd);
end $$;
revoke all on function public.access_enqueue_agent_read(uuid,text,uuid,uuid,text,bigint,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.access_enqueue_agent_read(uuid,text,uuid,uuid,text,bigint,uuid,text,text,text,jsonb) to service_role;

-- Extend the existing sanitized-by-admission, backend-only projection to the two
-- explicitly supported agent reports. Keep document tokens/maintenance excluded.
create or replace view public.access_visible_commands with (security_invoker=true) as
 select b.*,a.company_id as access_company_id,
 case
  when a.permission in ('purchases.view','purchases.prepare','purchases.submit','purchases.approve','purchases.post') then 'purchases.view'
  when a.permission in ('bank.view','bank.prepare','bank.submit','bank.approve','bank.post') then 'bank.view'
  when a.permission in ('discounts.view','discounts.prepare','discounts.submit','discounts.approve','discounts.post') then 'discounts.view'
  when a.permission in ('followups.view','followups.prepare','followups.submit','followups.approve','followups.post') then 'followups.view'
  when a.permission in ('purchases.export','bank.export','discounts.export','followups.export') then a.permission
  when a.permission='connections.manage' then 'connections.manage'
 end as visibility_permission
 from public.tally_bridge_commands b
 join public.access_command_authority a on a.command_id=b.id and a.organization_id=b.organization_id
 join public.tally_connections c on c.id=b.connection_id and c.owner_user_id=b.owner_user_id
  and c.installation_id=b.installation_id and c.session_generation=b.session_generation and c.revoked_at is null
 join public.access_company_links l on l.organization_id=a.organization_id and l.company_id=a.company_id
  and l.connection_id=b.connection_id and l.installation_id=b.installation_id
  and l.company_guid=b.company_guid and l.financial_year=b.financial_year
 where b.command_type in ('alter_ledger','create_ledger','sync_masters','fetch_bank_ledgers','fetch_purchase_masters',
  'post_bank_voucher','fetch_customer_open_bills','create_debit_note','export_debit_note_pdf','create_purchase_voucher',
  'verify_bank_transaction','agent_query_open_bills','agent_query_workflow_vouchers');
revoke all on public.access_visible_commands from public,anon,authenticated;
grant select on public.access_visible_commands to service_role;
commit;
