-- Kalika only. Unapplied to hosted projects; team activation remains blocked.
begin;
create function public.access_complete_purchase_command(p_command uuid,p_connection uuid,p_token_hash text,p_result jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare a public.access_command_authority; cmd record; c record; p record; org text;
 digest text; verified boolean; created boolean; already boolean;
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
 -- After an issued write, role revocation must not discard its outcome. The
 -- immutable authority/case/command association is used, not the current actor's permissions.
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
 -- Preserve creator attribution. Never filter the posting by the connector owner's login.
 update public.purchase_invoice_tally_postings set
  status=case when verified then 'created' else 'verification_required' end,
  tally_voucher_number=nullif(p_result->>'voucherNumber',''),tally_master_id=nullif(p_result->>'masterId',''),
  tally_guid=nullif(p_result->>'guid',''),tally_created_at=case when created and not already then now() else tally_created_at end,
  verified_at=case when verified then now() else null end,verification_status=nullif(p_result->>'verificationStatus',''),
  last_error=case when verified then null else left(p_result->>'error',2000) end where id=p.id;
 -- This update invokes the existing authority trigger in the same transaction.
 -- Only verified results may mark the purchase workflow as posted.
 update public.tally_bridge_commands set status=case when verified then 'succeeded' else 'failed' end,
  result=p_result->'compactResult',error=case when verified then null else left(p_result->>'error',2000) end,
  completed_at=now()
  where id=p_command returning * into cmd;
 update public.access_command_authority set result_digest=digest,
  state=case when verified then 'completed' else 'uncertain' end,completed_at=now() where command_id=p_command;
 update public.tally_connections set last_heartbeat_at=now(),updated_at=now() where id=p_connection;
 insert into public.access_audit(organization_id,actor_id,action,target_id,revision,details)
 values(org,a.initiating_user_id,'purchase.result',a.case_id::text,a.approved_revision,
  jsonb_build_object('commandId',p_command,'verified',verified,'resultDigest',digest));
 return to_jsonb(cmd);
end $$;
revoke all on function public.access_complete_purchase_command(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.access_complete_purchase_command(uuid,uuid,text,jsonb) to service_role;
commit;
