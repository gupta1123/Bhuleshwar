-- Retain the frozen, approved canonical voucher after an uncertain or completed
-- team-access write. This allows read-back recovery without reconstructing or
-- recalculating the voucher from mutable case data.
begin;

create or replace function public.access_complete_purchase_command(p_command uuid,p_connection uuid,p_token_hash text,p_result jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare a public.access_command_authority; cmd record; c record; p record; org text;
 digest text; verified boolean; created boolean; already boolean;
 verification_only boolean; verified_absent boolean; completed boolean;
begin
 if jsonb_typeof(p_result) is distinct from 'object' or pg_column_size(p_result)>32768
  or jsonb_typeof(p_result->'verified') is distinct from 'boolean'
  or jsonb_typeof(p_result->'voucherCreated') is distinct from 'boolean'
  or jsonb_typeof(p_result->'alreadyInTally') is distinct from 'boolean'
  or jsonb_typeof(p_result->'compactResult') is distinct from 'object' then
  raise exception 'Invalid purchase completion' using errcode='22023';
 end if;
 digest:=encode(sha256(convert_to(p_result::text,'UTF8')),'hex');
 verified:=(p_result->>'verified')::boolean; created:=(p_result->>'voucherCreated')::boolean; already:=(p_result->>'alreadyInTally')::boolean;
 select organization_id into org from public.access_command_authority where command_id=p_command;
 if org is null then raise exception 'Issued command authority required' using errcode='42501';end if;
 perform 1 from public.access_organizations where id=org for update;
 select * into a from public.access_command_authority where command_id=p_command for update;
 select * into cmd from public.tally_bridge_commands where id=p_command and connection_id=p_connection for update;
 if not found or cmd.command_type<>'create_purchase_voucher' or a.case_id is null or a.permission<>'purchases.post'
  or cmd.organization_id is distinct from org then raise exception 'Purchase authority does not match command' using errcode='42501';end if;
 select * into c from public.tally_connections where id=p_connection for share;
 if not found or c.revoked_at is not null or c.bridge_token_hash is distinct from p_token_hash
  or cmd.owner_user_id is distinct from c.owner_user_id or cmd.installation_id is distinct from c.installation_id
  or cmd.session_generation is distinct from c.session_generation then
  raise exception 'Result pairing is no longer valid' using errcode='42501';end if;
 verification_only:=coalesce((cmd.payload->>'verificationOnly')::boolean,false);
 verified_absent:=verification_only and p_result->>'verificationStatus'='missing';
 completed:=verified or verified_absent;
 if a.result_digest is not null then
  if a.result_digest<>digest then raise exception 'Conflicting completion; verify the existing voucher' using errcode='40001';end if;
  return to_jsonb(cmd);
 end if;
 if a.state not in ('issued','uncertain') or cmd.status not in ('claimed','failed') then
  raise exception 'Command was not issued or is already terminal' using errcode='55000';end if;
 select * into p from public.purchase_invoice_tally_postings
  where command_id=p_command and case_id=a.case_id and connection_id=p_connection for update;
 if not found then raise exception 'The issued purchase record is missing' using errcode='55000';end if;
 if exists(select 1 from public.purchase_invoice_tally_postings where command_id=p_command and id<>p.id) then
  raise exception 'Ambiguous issued posting' using errcode='55000';end if;
 perform 1 from public.access_purchase_workflows where case_id=a.case_id and command_id=p_command
  and approved_revision=a.approved_revision and financial_revision=a.approved_revision and state='posting' for update;
 if not found then raise exception 'The issued approved revision is inconsistent' using errcode='40001';end if;
 update public.purchase_invoice_tally_postings set
  status=case when verified then 'created' when verified_absent then 'ready_for_approval' else 'verification_required' end,
  command_id=case when verified_absent then null else command_id end,
  tally_voucher_number=nullif(p_result->>'voucherNumber',''),tally_master_id=nullif(p_result->>'masterId',''),
  tally_guid=nullif(p_result->>'guid',''),tally_created_at=case when verified_absent then null when created and not already then now() else tally_created_at end,
  verified_at=case when verified then now() else null end,verification_status=nullif(p_result->>'verificationStatus',''),
  last_error=case when verified then null else left(p_result->>'error',2000) end where id=p.id;
 update public.tally_bridge_commands set status=case when completed then 'succeeded' else 'failed' end,
  result=p_result->'compactResult',error=case when completed then null else left(p_result->>'error',2000) end,
  completed_at=now()
  where id=p_command returning * into cmd;
 update public.access_command_authority set result_digest=digest,
  state=case when completed then 'completed' else 'uncertain' end,completed_at=now() where command_id=p_command;
 if verified_absent then
  update public.access_purchase_workflows set state='approved',command_id=null,revision=revision+1,updated_at=now()
   where case_id=a.case_id and command_id=p_command;
 end if;
 update public.tally_connections set last_heartbeat_at=now(),updated_at=now() where id=p_connection;
 insert into public.access_audit(organization_id,actor_id,action,target_id,revision,details)
 values(org,a.initiating_user_id,'purchase.result',a.case_id::text,a.approved_revision,
  jsonb_build_object('commandId',p_command,'verified',verified,'resultDigest',digest));
 return to_jsonb(cmd);
end $$;

revoke all on function public.access_complete_purchase_command(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.access_complete_purchase_command(uuid,uuid,text,jsonb) to service_role;

create or replace function public.queue_purchase_invoice_tally_verification(
 p_posting_id uuid,p_owner_user_id uuid,p_connection_id uuid,p_previous_command_id uuid,p_requested_at timestamptz
) returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.purchase_invoice_tally_postings%rowtype; previous record; current record; cid uuid;
begin
 select * into p from public.purchase_invoice_tally_postings where id=p_posting_id and owner_user_id=p_owner_user_id for update;
 if not found or p.connection_id is distinct from p_connection_id then raise exception 'Purchase posting not found' using errcode='55000';end if;
 if p.status='queued' and p.command_id is not null then
  select * into current from public.tally_bridge_commands where id=p.command_id;
  if found and coalesce((current.payload->>'verificationOnly')::boolean,false) then return p.command_id;end if;
 end if;
 if p.status<>'verification_required' or p.command_id is distinct from p_previous_command_id then
  raise exception 'Purchase voucher is not awaiting verification' using errcode='55000';end if;
 select * into previous from public.tally_bridge_commands where id=p_previous_command_id and connection_id=p_connection_id for share;
 if not found or previous.command_type<>'create_purchase_voucher' or previous.payload->>'postingId' is distinct from p.id::text
  or previous.payload->>'caseId' is distinct from p.case_id::text or previous.payload->'canonicalVersion' is null then
  raise exception 'Frozen approved voucher is unavailable for verification' using errcode='55000';end if;
 insert into public.tally_bridge_commands(connection_id,owner_user_id,command_type,status,priority,payload,max_attempts)
 values(p_connection_id,p_owner_user_id,'create_purchase_voucher','queued',45,
  previous.payload||jsonb_build_object('verificationOnly',true,'verificationRequestedAt',p_requested_at,'previousCommandId',p_previous_command_id),1)
 returning id into cid;
 update public.purchase_invoice_tally_postings set status='queued',command_id=cid,queued_at=p_requested_at,
  last_error=null where id=p.id;
 return cid;
end $$;
revoke all on function public.queue_purchase_invoice_tally_verification(uuid,uuid,uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.queue_purchase_invoice_tally_verification(uuid,uuid,uuid,uuid,timestamptz) to service_role;

create or replace function public.access_enqueue_purchase_verification(
 p_actor uuid,p_org text,p_case uuid,p_connection uuid,p_requested_at timestamptz
) returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare s public.access_resource_scopes; w public.access_purchase_workflows; p record; c record; link record;
 previous_authority public.access_command_authority; cid uuid;
begin
 perform 1 from public.access_organizations where id=p_org for update;
 select * into s from public.access_resource_scopes where resource_type='case' and resource_id=p_case and organization_id=p_org for update;
 if not found then raise exception 'Purchase outside organization' using errcode='42501';end if;
 perform public.access_assert_permission(p_actor,p_org,'purchases.post',s.company_id);
 select * into w from public.access_purchase_workflows where case_id=p_case for update;
 if not found or w.state<>'posting' or w.approved_revision is distinct from w.financial_revision then
  raise exception 'Approved purchase verification is unavailable' using errcode='55000';end if;
 select * into p from public.purchase_invoice_tally_postings where case_id=p_case and connection_id=p_connection for update;
 if not found or p.status<>'verification_required' or p.command_id is null then raise exception 'Purchase voucher is not awaiting verification' using errcode='55000';end if;
 select * into previous_authority from public.access_command_authority where command_id=p.command_id and organization_id=p_org and case_id=p_case for share;
 if not found or previous_authority.state not in ('uncertain','completed') then raise exception 'Issued purchase authority is unavailable' using errcode='42501';end if;
 select * into c from public.tally_connections where id=p_connection and revoked_at is null for share;
 if not found or c.installation_id is null or c.session_generation is null then raise exception 'Connector unavailable' using errcode='55000';end if;
 select * into link from public.access_company_links where organization_id=p_org and company_id=s.company_id
  and connection_id=c.id and installation_id=c.installation_id for share;
 if not found then raise exception 'Verified company and installation mapping required' using errcode='42501';end if;
 cid:=public.queue_purchase_invoice_tally_verification(p.id,p.owner_user_id,c.id,p.command_id,p_requested_at);
 update public.tally_bridge_commands set owner_user_id=c.owner_user_id,organization_id=p_org,
  installation_id=c.installation_id,session_generation=c.session_generation,company_guid=link.company_guid,
  financial_year=link.financial_year,protocol_version=1,job_class='interactive_read',max_attempts=1 where id=cid;
 insert into public.access_command_authority(command_id,organization_id,company_id,initiating_user_id,permission,case_id,approved_revision)
 values(cid,p_org,s.company_id,p_actor,'purchases.post',p_case,w.approved_revision);
 update public.access_purchase_workflows set state='approved',command_id=null,revision=revision+1,updated_at=now() where case_id=p_case;
 insert into public.access_audit(organization_id,actor_id,action,target_id,revision,details)
 values(p_org,p_actor,'purchase.verify',p_case::text,w.revision,jsonb_build_object('commandId',cid));
 return cid;
end $$;
revoke all on function public.access_enqueue_purchase_verification(uuid,text,uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.access_enqueue_purchase_verification(uuid,text,uuid,uuid,timestamptz) to service_role;

commit;
