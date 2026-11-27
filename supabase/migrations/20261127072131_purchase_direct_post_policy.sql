-- Deploy the policy-aware API and web app before applying this migration.
begin;
alter table public.access_organizations add column purchase_approval_required boolean not null default true;
alter table public.access_purchase_workflows add column direct_post boolean not null default false;
do $$ declare c record;begin
 for c in select conname from pg_constraint where conrelid='public.access_purchase_workflows'::regclass and contype='c'
   and pg_get_constraintdef(oid) like '%approved_by%' and pg_get_constraintdef(oid) like '%financial_revision%' loop
   execute format('alter table public.access_purchase_workflows drop constraint %I',c.conname);
 end loop;
end $$;
alter table public.access_purchase_workflows add constraint access_purchase_dispatch_checkpoint
 check(state not in ('approved','posting','posted') or (approved_revision is not null and approved_revision=financial_revision and (approved_by is not null or direct_post)));
create or replace function public.access_snapshot(p_user uuid,p_org text default null) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare o public.access_organizations; m public.access_members; r public.access_roles; choices jsonb;
begin
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name) order by a.name),'[]') into choices
 from public.access_organizations a join public.access_members b on b.organization_id=a.id
 where b.user_id=p_user and b.status='active';
 if p_org is null then
  if jsonb_array_length(choices)<>1 then return jsonb_build_object('organizations',choices,'selectionRequired',true); end if;
  p_org:=choices->0->>'id';
 end if;
 select * into m from public.access_members where user_id=p_user and organization_id=p_org and status='active';
 if not found then raise exception 'Membership unavailable' using errcode='42501'; end if;
 select * into o from public.access_organizations where id=p_org;
 select * into r from public.access_roles where id=m.role_id and organization_id=p_org and not archived;
 if not found then raise exception 'Role unavailable' using errcode='42501'; end if;
 return jsonb_build_object('organizationId',o.id,'organizationName',o.name,'revision',o.revision,
 'purchaseApprovalRequired',o.purchase_approval_required,'sharingEnabled',o.sharing_enabled,'allowSelfApproval',o.allow_self_approval,
 'member',to_jsonb(m),'role',to_jsonb(r),'organizations',choices,
 'companies',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) order by name),'[]') from public.access_companies where organization_id=p_org and (m.is_owner or m.all_companies or id=any(m.company_ids))));
end $$;
create or replace function public.access_purchase_transition(p_actor uuid,p_org text,p_case uuid,p_action text,p_revision bigint,p_digest text default null,p_reason text default null,p_source_revision bigint default 0)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare s public.access_resource_scopes; w public.access_purchase_workflows; permission_key text; self_approval boolean;
begin
 -- Same lock order as role changes and command dispatch. A revocation/transition race is serialized.
 select allow_self_approval into self_approval from public.access_organizations where id=p_org for update;
 if not found then raise exception 'Organization not found' using errcode='42501';end if;
 if exists(select 1 from public.access_organizations where id=p_org and not purchase_approval_required) then
   raise exception 'Separate purchase approval is disabled for this organization' using errcode='55000';end if;

 select * into s from public.access_resource_scopes where resource_type='case' and resource_id=p_case and organization_id=p_org for update;
 if not found then raise exception 'Case is outside scope' using errcode='42501';end if;
 if s.source_revision<>p_source_revision then raise exception 'Saved financial inputs changed' using errcode='40001';end if;
 permission_key:=case p_action when 'prepare' then 'purchases.prepare' when 'submit' then 'purchases.submit' when 'approve' then 'purchases.approve' when 'return' then 'purchases.approve' else null end;
 if permission_key is null then raise exception 'Unsupported transition' using errcode='22023';end if;
 perform public.access_assert_permission(p_actor,p_org,permission_key,s.company_id);
 select * into w from public.access_purchase_workflows where case_id=p_case for update;
 if not found then
   if p_action<>'prepare' or p_revision<>0 or p_digest is null or p_digest !~ '^[0-9a-f]{64}$' then raise exception 'Prepare a current revision first' using errcode='40001';end if;
   insert into public.access_purchase_workflows(case_id,financial_digest,prepared_by) values(p_case,p_digest,p_actor) returning * into w;
 else
   if p_revision<>w.revision then raise exception 'Stale workflow revision' using errcode='40001';end if;
   if p_action='prepare' then
     if w.state<>'draft' then raise exception 'Return submitted work before editing' using errcode='55000';end if;
     if p_digest is null or p_digest !~ '^[0-9a-f]{64}$' then raise exception 'Invalid digest' using errcode='22023';end if;
     if w.financial_digest=p_digest then return to_jsonb(w);end if;
     w.financial_digest:=p_digest;w.financial_revision:=w.financial_revision+1;w.prepared_by:=p_actor;
     w.approved_by:=null;w.approved_at:=null;w.approved_revision:=null;
   elsif p_action='submit' then
     if w.state<>'draft' then raise exception 'Only draft work can be submitted' using errcode='55000';end if;
     if p_digest is distinct from w.financial_digest then raise exception 'Financial details changed' using errcode='40001';end if;
     w.state:='awaiting_approval';w.submitted_by:=p_actor;w.submitted_at:=now();
   elsif p_action='approve' then
     if w.state<>'awaiting_approval' then raise exception 'Work is not awaiting approval' using errcode='55000';end if;
     if not self_approval and (p_actor=w.submitted_by or p_actor=w.prepared_by) then raise exception 'Another approver must review this purchase' using errcode='42501';end if;
     if p_digest is distinct from w.financial_digest then raise exception 'Financial details changed' using errcode='40001';end if;
     w.state:='approved';w.approved_by:=p_actor;w.approved_revision:=w.financial_revision;w.approved_at:=now();
   elsif p_action='return' then
     if w.state not in ('awaiting_approval','approved') then raise exception 'Work cannot be returned in its current state' using errcode='55000';end if;
     if length(trim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'A return reason is required' using errcode='22023';end if;
     w.state:='draft';w.last_return_reason:=trim(p_reason);w.approved_by:=null;w.approved_revision:=null;w.approved_at:=null;
   end if;
   w.revision:=w.revision+1;w.updated_at:=now();
   update public.access_purchase_workflows set state=w.state,revision=w.revision,financial_revision=w.financial_revision,
     financial_digest=w.financial_digest,prepared_by=w.prepared_by,submitted_by=w.submitted_by,submitted_at=w.submitted_at,
     approved_by=w.approved_by,approved_revision=w.approved_revision,approved_at=w.approved_at,last_return_reason=w.last_return_reason,updated_at=w.updated_at where case_id=p_case;
 end if;
 insert into public.access_audit(organization_id,actor_id,action,target_id,revision,details)
 values(p_org,p_actor,'purchase.'||p_action,p_case::text,w.revision,jsonb_build_object('financialRevision',w.financial_revision,'state',w.state));
 return to_jsonb(w);
end $$;
create or replace function public.access_enqueue_purchase(
 p_actor uuid,p_org text,p_case uuid,p_workflow_revision bigint,p_source_revision bigint,
 p_financial_digest text,p_args jsonb
) returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare s public.access_resource_scopes; w public.access_purchase_workflows;
 p record; c record; link record; cid uuid; existing_authority public.access_command_authority;
begin
 perform 1 from public.access_organizations where id=p_org for update;
 select * into s from public.access_resource_scopes where resource_type='case' and resource_id=p_case and organization_id=p_org for update;
 if not found then raise exception 'Purchase outside organization' using errcode='42501';end if;
 perform public.access_assert_permission(p_actor,p_org,'purchases.post',s.company_id);
 select * into w from public.access_purchase_workflows where case_id=p_case for update;
 -- Direct posting is a separate organization policy, never a bypass of team access.
 -- Freeze a dispatch checkpoint on the existing confirmation click. No reviewer,
 -- submission or approval is attributed to a user in this mode.
 if not (select purchase_approval_required from public.access_organizations where id=p_org) then
   if s.source_revision<>p_source_revision then raise exception 'Saved financial details changed' using errcode='40001';end if;
   if p_financial_digest is null or p_financial_digest !~ '^[0-9a-f]{64}$' then raise exception 'Invalid financial digest' using errcode='22023';end if;
   select * into p from public.purchase_invoice_tally_postings where id=(p_args->>'p_posting_id')::uuid and case_id=p_case for update;
   if not found or p.connection_id is distinct from (p_args->>'p_connection_id')::uuid then raise exception 'Saved posting connection changed' using errcode='40001';end if;
   if p.command_id is not null then
     select * into existing_authority from public.access_command_authority where command_id=p.command_id and case_id=p_case and organization_id=p_org;
   end if;
   if existing_authority.command_id is null or existing_authority.state not in ('queued','issued','completed','uncertain') then
     if p.status in ('queued','creating','created','sending','verification_required') or w.state in ('posting','posted') then
       raise exception 'Verify the existing Tally posting before retrying' using errcode='55000';end if;
     insert into public.access_purchase_workflows(case_id,state,financial_digest,prepared_by,approved_by,approved_revision,approved_at,direct_post)
     values(p_case,'approved',p_financial_digest,p_actor,null,1,now(),true)
     on conflict(case_id) do update set state='approved',financial_digest=excluded.financial_digest,
       prepared_by=p_actor,submitted_by=null,submitted_at=null,approved_by=null,
       approved_revision=access_purchase_workflows.financial_revision,approved_at=now(),direct_post=true,
       revision=access_purchase_workflows.revision+1,updated_at=now()
     returning * into w;
   end if;
   p_workflow_revision:=w.revision;
 end if;
 if w.case_id is null or w.state not in ('approved','posting','posted') then raise exception 'Purchase approval required' using errcode='55000';end if;
 if w.financial_digest is distinct from p_financial_digest or w.approved_revision is distinct from w.financial_revision or s.source_revision<>p_source_revision then
   raise exception 'Approved financial details changed' using errcode='40001';
 end if;
 select * into p from public.purchase_invoice_tally_postings where id=(p_args->>'p_posting_id')::uuid and case_id=p_case for update;
 if not found or p.connection_id is distinct from (p_args->>'p_connection_id')::uuid then raise exception 'Saved posting connection changed' using errcode='40001';end if;
 if p.command_id is not null then
   select * into existing_authority from public.access_command_authority where command_id=p.command_id and case_id=p_case and organization_id=p_org;
   if found and existing_authority.state in ('queued','issued','completed','uncertain') then return p.command_id;end if;
 end if;
 if w.state<>'approved' or w.revision<>p_workflow_revision then raise exception 'Purchase approval revision changed' using errcode='40001';end if;
 select * into c from public.tally_connections where id=p.connection_id and revoked_at is null for share;
 if not found or c.installation_id is null or c.session_generation is null then raise exception 'Connector unavailable' using errcode='55000';end if;
 if (select count(*) from public.access_company_links where organization_id=p_org and company_id=s.company_id and connection_id=c.id and installation_id=c.installation_id)<>1 then
   raise exception 'Verified company and installation mapping required' using errcode='42501';
 end if;
 select * into link from public.access_company_links where organization_id=p_org and company_id=s.company_id and connection_id=c.id and installation_id=c.installation_id;
 if p_args->'p_tally_payload'->>'companyName' is distinct from public.access_tally_company_name(c.id,link.company_guid,link.financial_year,s.company_id,p_org) then
   raise exception 'Voucher company differs from approved company' using errcode='42501';
 end if;
 -- The legacy atomic queue still enforces duplicate invoice and posting-revision rules.
 -- Its attribution owner is the saved posting owner, NOT the acting teammate.
 cid:=public.queue_purchase_invoice_tally_posting(p.id,p.owner_user_id,c.id,
   (p_args->>'p_master_sync_run_id')::uuid,p_args->>'p_duplicate_key',p_args->>'p_idempotency_key',
   p_args->>'p_approved_payload_hash',w.approved_at,p_args->'p_tally_payload',(p_args->>'p_revision')::integer);
 -- Paired connector identity is preserved separately from the initiating user.
 update public.tally_bridge_commands set owner_user_id=c.owner_user_id,organization_id=p_org,
   installation_id=c.installation_id,session_generation=c.session_generation,company_guid=link.company_guid,
   financial_year=link.financial_year,protocol_version=1,job_class='tally_write',max_attempts=1 where id=cid;
 insert into public.access_command_authority(command_id,organization_id,company_id,initiating_user_id,permission,case_id,approved_revision)
 values(cid,p_org,s.company_id,p_actor,'purchases.post',p_case,w.approved_revision);
 insert into public.access_audit(organization_id,actor_id,action,target_id,revision,details)
 values(p_org,p_actor,'purchase.queue',p_case::text,w.revision,jsonb_build_object('commandId',cid,'approvedRevision',w.approved_revision,'directPost',w.direct_post));
 return cid;
end $$;
create or replace function public.access_guard_purchase_edit() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare cid uuid; org text; w public.access_purchase_workflows; old_json jsonb; new_json jsonb;
begin
 if tg_op<>'INSERT' then old_json:=to_jsonb(old);end if;
 if tg_op<>'DELETE' then new_json:=to_jsonb(new);end if;
 if tg_op='UPDATE' and new_json->>'case_id' is distinct from old_json->>'case_id' then
   raise exception 'A financial record cannot be moved between cases' using errcode='22023';
 end if;
 cid:=coalesce((new_json->>'case_id')::uuid,(old_json->>'case_id')::uuid);
 if tg_table_name='packet_documents' and tg_op='UPDATE' and
   (new_json->'extracted_fields',new_json->'document_type') is not distinct from (old_json->'extracted_fields',old_json->'document_type') then return new;end if;
 if tg_table_name='purchase_invoice_tally_postings' and tg_op='UPDATE' and
   (new_json->'review_patch',new_json->'connection_id') is not distinct from (old_json->'review_patch',old_json->'connection_id') then return new;end if;
 select organization_id into org from public.access_resource_scopes where resource_type='case' and resource_id=cid;
 if org is not null then
   perform 1 from public.access_organizations where id=org for update;
   perform 1 from public.access_resource_scopes where resource_type='case' and resource_id=cid for update;
   select * into w from public.access_purchase_workflows where case_id=cid for update;
   if (select purchase_approval_required from public.access_organizations where id=org) then
     if w.state is not null and w.state<>'draft' then raise exception 'Return submitted work before editing financial details' using errcode='55000';end if;
   else
     if w.state in ('posting','posted') or exists(select 1 from public.purchase_invoice_tally_postings where case_id=cid and status in ('queued','creating','created','sending','verification_required')) then
       raise exception 'The Tally posting is in progress or already issued; verify it before editing' using errcode='55000';end if;
     -- Previous submissions stop locking the case; keep the historical workflow
     -- and approval audit intact until actual financial input changes.
     if w.state in ('awaiting_approval','approved') then
       update public.access_purchase_workflows set state='draft',approved_by=null,approved_revision=null,approved_at=null,
         submitted_by=null,submitted_at=null,direct_post=true where case_id=cid;
     end if;
   end if;
   update public.access_resource_scopes set source_revision=source_revision+1 where resource_type='case' and resource_id=cid;
   update public.access_purchase_workflows set revision=revision+1,financial_revision=financial_revision+1,financial_digest=repeat('0',64),updated_at=now() where case_id=cid;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;

-- Existing approval requirements remain in force for every other organization.
update public.access_organizations
set purchase_approval_required=false, revision=revision+1
where id='bhuleshwar' and purchase_approval_required;
commit;
