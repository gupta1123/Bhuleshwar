-- Kalika only. Prepared for manual application; does not activate sharing.
begin;
create table public.access_proposal_operations (
 command_id uuid primary key references public.tally_bridge_commands(id),
 proposal_id uuid not null, operation text not null check(operation in ('native_pdf','phone')),
 source_digest text not null, result_digest text, created_at timestamptz not null default now()
);
create index access_proposal_operations_proposal on public.access_proposal_operations(proposal_id,operation);
alter table public.access_proposal_operations enable row level security;
revoke all on public.access_proposal_operations from public,anon,authenticated;
grant select,insert,update,delete on public.access_proposal_operations to service_role;

create function public.access_proposal_operation_digest(p jsonb) returns text
language sql immutable set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to(jsonb_build_array(p->'access_organization_id',p->'access_company_id',
 p->'company_name',p->'financial_year',p->'party_ledger_name',p->'recoverable_amount',
 p->'tally_voucher_id',p->'tally_voucher_number',p->'tally_open_reference_name',p->'status')::text,'UTF8')),'hex')
$$;
create function public.access_enqueue_proposal_operation(p_actor uuid,p_org text,p_proposal uuid,
 p_connection uuid,p_installation text,p_generation bigint,p_guid text,p_year text,p_operation text,p_phone text default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p record;c record;cmd record;perm text;payload jsonb;s record;
begin
 perm:=case p_operation when 'native_pdf' then 'discounts.export' when 'phone' then 'connections.manage' end;
 if perm is null then raise exception 'Unsupported proposal operation' using errcode='22023';end if;
 perform 1 from public.access_organizations where id=p_org for update;
 select * into s from public.access_resource_scopes where resource_type='proposal' and resource_id=p_proposal and organization_id=p_org for share;
 if not found or s.company_id is null then raise exception 'Proposal scope unavailable' using errcode='42501';end if;
 perform public.access_assert_permission(p_actor,p_org,'discounts.export',s.company_id);
 perform public.access_assert_permission(p_actor,p_org,perm,s.company_id);
 select * into p from public.debit_note_proposals where id=p_proposal for update;
 if not found or p.access_organization_id is distinct from p_org or p.access_company_id is distinct from s.company_id
  or p.status<>'created_in_tally' or p.financial_year is distinct from p_year then
  raise exception 'Created proposal and financial year required' using errcode='42501';end if;
 select * into c from public.tally_connections where id=p_connection for share;
 if not found or c.revoked_at is not null or c.installation_id is distinct from p_installation or c.session_generation is distinct from p_generation then
  raise exception 'Pairing changed' using errcode='42501';end if;
 perform 1 from public.access_company_links where organization_id=p_org and company_id=s.company_id and connection_id=c.id
  and installation_id=p_installation and company_guid=p_guid and financial_year=p_year for share;
 if not found then raise exception 'Verified dataset required' using errcode='42501';end if;
 select b.* into cmd from public.access_proposal_operations o join public.tally_bridge_commands b on b.id=o.command_id
 where o.proposal_id=p_proposal and o.operation=p_operation and b.connection_id=c.id
  and b.installation_id=p_installation and b.session_generation=p_generation and b.status in ('queued','claimed')
 order by b.created_at desc limit 1;
 if found then return to_jsonb(cmd);end if;
 if p_operation='phone' then
  if p_phone is null or p_phone !~ '^[0-9]{10,15}$' then raise exception 'Invalid phone' using errcode='22023';end if;
  payload:=jsonb_build_object('proposalId',p.id,'oldName',p.party_ledger_name,'newName',p.party_ledger_name,'phoneNumber',p_phone,'reason','cash_discount_whatsapp_phone_capture');
 else
  if coalesce(nullif(p.tally_open_reference_name,''),nullif(p.tally_voucher_number,'')) is null then
   raise exception 'Voucher reference is required' using errcode='22023';end if;
  payload:=jsonb_build_object('proposalId',p.id,'operation','export_native_pdf','tallyVoucherId',p.tally_voucher_id,
    'tallyVoucherNumber',p.tally_voucher_number,'voucherDate',coalesce(p.tally_voucher_date,p.debit_note_date),
    'referenceNumber',coalesce(nullif(p.tally_open_reference_name,''),p.tally_voucher_number),
    'partyLedgerName',p.party_ledger_name,'amount',p.recoverable_amount);
 end if;
 payload:=payload||jsonb_build_object('companyName',p.company_name,'companyGuid',p_guid,'financialYear',p_year);
 insert into public.tally_bridge_commands(connection_id,owner_user_id,organization_id,installation_id,session_generation,company_guid,financial_year,
 command_type,status,priority,payload,protocol_version,job_class,max_attempts,deadline_at)
 values(c.id,c.owner_user_id,p_org,p_installation,p_generation,p_guid,p_year,
 case p_operation when 'phone' then 'alter_ledger' else 'create_debit_note' end,'queued',45,payload,1,
 case p_operation when 'phone' then 'tally_write' else 'tally_read' end,1,now()+interval '5 minutes') returning * into cmd;
 insert into public.access_command_authority(command_id,organization_id,company_id,initiating_user_id,permission)
 values(cmd.id,p_org,s.company_id,p_actor,perm);
 insert into public.access_proposal_operations(command_id,proposal_id,operation,source_digest)
 values(cmd.id,p.id,p_operation,public.access_proposal_operation_digest(to_jsonb(p)));
 return to_jsonb(cmd);
end $$;

create function public.access_guard_proposal_operation() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare o record;p record;
begin
 if new.status='claimed' and old.status='queued' then
  select * into o from public.access_proposal_operations where command_id=new.id;
  if found then
   select * into p from public.debit_note_proposals where id=o.proposal_id for share;
   if not found or o.source_digest is distinct from public.access_proposal_operation_digest(to_jsonb(p)) then
    raise exception 'Proposal changed; request the operation again' using errcode='40001';end if;
  end if;
 end if;
 return new;
end $$;
create trigger access_proposal_operation_dispatch before update of status on public.tally_bridge_commands
 for each row execute function public.access_guard_proposal_operation();

create function public.access_complete_proposal_operation(p_command uuid,p_connection uuid,p_token_hash text,p_result jsonb,p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare a record;c record;b record;o record;p record;dig text;org text;success boolean;
begin
 select organization_id into org from public.access_command_authority where command_id=p_command;
 if org is null then raise exception 'Operation authority missing' using errcode='42501';end if;
 perform 1 from public.access_organizations where id=org for update;
 select * into a from public.access_command_authority where command_id=p_command for update;
 select * into b from public.tally_bridge_commands where id=p_command and connection_id=p_connection for update;
 if not found then raise exception 'Command missing' using errcode='42501';end if;
 select * into c from public.tally_connections where id=p_connection for share;
 if not found or c.bridge_token_hash is distinct from p_token_hash or c.revoked_at is not null
  or c.installation_id is distinct from b.installation_id or c.session_generation is distinct from b.session_generation
  or c.owner_user_id is distinct from b.owner_user_id then raise exception 'Pairing changed' using errcode='42501';end if;
 select * into o from public.access_proposal_operations where command_id=p_command for update;
 if not found or a.state not in ('issued','uncertain','completed') then raise exception 'Issued operation required' using errcode='42501';end if;
 if jsonb_typeof(p_result) is distinct from 'object' or jsonb_typeof(p_patch) is distinct from 'object' or pg_column_size(p_result)>65536 or pg_column_size(p_patch)>65536 then
  raise exception 'Invalid compact result' using errcode='22023';end if;
 dig:=encode(sha256(convert_to(jsonb_build_array(p_result,p_patch)::text,'UTF8')),'hex');
 if o.result_digest is not null then
  if o.result_digest<>dig then raise exception 'Conflicting result' using errcode='40001';end if;
  return to_jsonb(b);
 end if;
 select * into p from public.debit_note_proposals where id=o.proposal_id for update;
 if not found or p.access_organization_id is distinct from org or p.access_company_id is distinct from a.company_id then
  raise exception 'Proposal scope changed' using errcode='42501';end if;
 success:=coalesce((p_result->>'success')::boolean,false);
 if o.operation='native_pdf' and success then
  perform public.access_assert_permission(a.initiating_user_id,org,'discounts.export',a.company_id);
  if o.source_digest is distinct from public.access_proposal_operation_digest(to_jsonb(p)) then
   raise exception 'Voucher changed during export' using errcode='40001';end if;
  if nullif(p_patch->>'tally_pdf_reference','') is null or coalesce(p_patch->'nativeTallyPdf'->>'sha256','') !~ '^[a-f0-9]{64}$' then
   raise exception 'Verified PDF evidence required' using errcode='22023';end if;
  update public.debit_note_proposals set tally_pdf_reference=p_patch->>'tally_pdf_reference',
   customer_snapshot=coalesce(customer_snapshot,'{}')||jsonb_build_object('nativeTallyPdf',p_patch->'nativeTallyPdf'),last_error=null,updated_at=now() where id=p.id;
 end if;
 update public.tally_bridge_commands set status=case when success then 'succeeded' else 'failed' end,
 result=p_result,error=case when success then null else left(coalesce(p_result->>'error','Operation failed'),1000) end,completed_at=now() where id=p_command returning * into b;
 update public.access_command_authority set state=case when success or o.operation='native_pdf' then 'completed' else 'uncertain' end,completed_at=now() where command_id=p_command;
 update public.access_proposal_operations set result_digest=dig where command_id=p_command;
 return to_jsonb(b);
end $$;
revoke all on function public.access_proposal_operation_digest(jsonb),public.access_enqueue_proposal_operation(uuid,text,uuid,uuid,text,bigint,text,text,text,text),
 public.access_guard_proposal_operation(),public.access_complete_proposal_operation(uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.access_proposal_operation_digest(jsonb),public.access_enqueue_proposal_operation(uuid,text,uuid,uuid,text,bigint,text,text,text,text),
 public.access_guard_proposal_operation(),public.access_complete_proposal_operation(uuid,uuid,text,jsonb,jsonb) to service_role;
commit;
