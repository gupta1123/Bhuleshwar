-- Additive only. No hosted activation, inferred company mapping, or historical approval.
begin;

create table public.access_resource_scopes (
  resource_type text not null check (resource_type in ('case','bank_import','bank_account','proposal','connection')),
  resource_id uuid not null,
  organization_id text not null references public.access_organizations(id),
  company_id uuid,
  creator_user_id uuid references auth.users(id),
  mapped_at timestamptz not null default now(),
  mapping_evidence text not null,
  source_revision bigint not null default 0,
  primary key(resource_type,resource_id),
  foreign key(organization_id,company_id) references public.access_companies(organization_id,id)
);
create index access_resource_scope_listing on public.access_resource_scopes(organization_id,resource_type,company_id,resource_id);
create index access_resource_scope_creator on public.access_resource_scopes(organization_id,creator_user_id,resource_type);

-- Explicit authorization columns keep counts/search/page queries indexed and scoped
-- without materializing every permitted record ID in application memory.
do $$ declare table_name text;begin
 foreach table_name in array array['packet_cases','bank_statement_imports','bank_accounts','debit_note_proposals','tally_connections'] loop
   if to_regclass('public.'||table_name) is not null then
     execute format('alter table public.%I add column if not exists access_organization_id text, add column if not exists access_company_id uuid',table_name);
     execute format('create index if not exists %I on public.%I(access_organization_id,access_company_id,id)',table_name||'_access_scope_idx',table_name);
     execute format('alter table public.%I add constraint %I foreign key(access_organization_id,access_company_id) references public.access_companies(organization_id,id)',table_name,table_name||'_access_company_fk');
   end if;
 end loop;
end $$;
create function public.access_mirror_resource_scope() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare table_name text; resource record;
begin
 if tg_op='DELETE' then resource:=old;else resource:=new;end if;
 table_name:=case resource.resource_type when 'case' then 'packet_cases' when 'bank_import' then 'bank_statement_imports' when 'bank_account' then 'bank_accounts' when 'proposal' then 'debit_note_proposals' when 'connection' then 'tally_connections' end;
 if tg_op='UPDATE' and (old.resource_type,old.resource_id) is distinct from (new.resource_type,new.resource_id) then raise exception 'Resource identity is immutable' using errcode='22023';end if;
 if to_regclass('public.'||table_name) is not null then
   execute format('update public.%I set access_organization_id=$1,access_company_id=$2 where id=$3',table_name) using case when tg_op='DELETE' then null else resource.organization_id end,case when tg_op='DELETE' then null else resource.company_id end,resource.resource_id;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger access_mirror_resource_scope after insert or update of organization_id,company_id on public.access_resource_scopes for each row execute function public.access_mirror_resource_scope();
create trigger access_remove_resource_scope after delete on public.access_resource_scopes for each row execute function public.access_mirror_resource_scope();
revoke all on function public.access_mirror_resource_scope() from public,anon,authenticated;
grant execute on function public.access_mirror_resource_scope() to service_role;

create table public.access_company_links (
  organization_id text not null,
  company_id uuid not null,
  connection_id uuid not null,
  installation_id text not null,
  company_guid text not null check(length(trim(company_guid))>0),
  financial_year text not null check(length(trim(financial_year))>0),
  verified_at timestamptz not null,
  evidence text not null,
  primary key(organization_id,connection_id,installation_id,company_guid,financial_year),
  foreign key(organization_id,company_id) references public.access_companies(organization_id,id)
);
create index access_company_links_company on public.access_company_links(organization_id,company_id,connection_id);

create table public.access_purchase_workflows (
  case_id uuid primary key,
  resource_type text not null default 'case' check(resource_type='case'),
  state text not null default 'draft' check(state in ('draft','awaiting_approval','approved','posting','posted')),
  revision bigint not null default 1,
  financial_revision bigint not null default 1,
  financial_digest text not null check(length(financial_digest)=64),
  prepared_by uuid not null references auth.users(id),
  submitted_by uuid references auth.users(id),
  submitted_at timestamptz,
  approved_by uuid references auth.users(id),
  approved_revision bigint,
  approved_at timestamptz,
  command_id uuid unique,
  last_return_reason text,
  updated_at timestamptz not null default now(),
  foreign key(resource_type,case_id) references public.access_resource_scopes(resource_type,resource_id),
  check (state not in ('approved','posting','posted') or (approved_by is not null and approved_revision=financial_revision))
);

-- A receipt separates the initiating user's authority from a connector's paired identity.
-- Starting a write is the authorization boundary; an issued write can finish after revocation.
create table public.access_command_authority (
  command_id uuid primary key,
  organization_id text not null references public.access_organizations(id),
  company_id uuid not null,
  initiating_user_id uuid not null references auth.users(id),
  permission text not null references public.access_permissions(key),
  case_id uuid references public.access_purchase_workflows(case_id),
  approved_revision bigint,
  state text not null default 'queued' check(state in ('queued','issued','completed','cancelled','uncertain')),
  issued_at timestamptz,
  completed_at timestamptz,
  result_digest text,
  foreign key(organization_id,company_id) references public.access_companies(organization_id,id)
);
create index access_command_authority_pending on public.access_command_authority(organization_id,initiating_user_id,state) where state='queued';

create table public.access_organization_settings (
  organization_id text not null references public.access_organizations(id),
  setting_key text not null,
  value jsonb not null,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key(organization_id,setting_key)
);

alter table public.access_resource_scopes enable row level security;
alter table public.access_company_links enable row level security;
alter table public.access_purchase_workflows enable row level security;
alter table public.access_command_authority enable row level security;
alter table public.access_organization_settings enable row level security;
revoke all on public.access_resource_scopes,public.access_purchase_workflows,public.access_command_authority,public.access_organization_settings from public,anon,authenticated;
revoke all on public.access_company_links from public,anon,authenticated;
grant select,insert,update,delete on public.access_company_links to service_role;
grant select,insert,update,delete on public.access_resource_scopes,public.access_purchase_workflows,public.access_command_authority,public.access_organization_settings to service_role;

-- Current database membership, not JWT metadata. Called once per request or transition.
create function public.access_assert_permission(p_actor uuid,p_org text,p_permission text,p_company uuid)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare m public.access_members; r public.access_roles; module_key text:=split_part(p_permission,'.',1);
begin
 select * into m from public.access_members where organization_id=p_org and user_id=p_actor;
 select * into r from public.access_roles where organization_id=p_org and id=m.role_id;
 if m.user_id is null or m.status<>'active' or m.must_change_password or r.id is null or r.archived then
   raise exception 'Active membership required' using errcode='42501';
 end if;
 if not exists(select 1 from public.access_permissions where key=p_permission) then
   raise exception 'Unknown permission' using errcode='42501';
 end if;
 if p_company is not null and (not exists(select 1 from public.access_companies where id=p_company and organization_id=p_org) or not(m.all_companies or p_company=any(m.company_ids))) then
   raise exception 'Company is outside scope' using errcode='42501';
 end if;
 if module_key in ('team','roles','settings','connections') then
   if not m.is_owner and not p_permission=any(r.permissions) then raise exception 'Permission denied' using errcode='42501';end if;
 else
   if not module_key=any(m.modules) or not p_permission=any(r.permissions) then raise exception 'Permission denied' using errcode='42501';end if;
   -- Unclassified financial data is not a wildcard, even for an owner.
   if p_company is null or not exists(select 1 from public.access_companies where id=p_company and organization_id=p_org)
     or not (m.all_companies or p_company=any(m.company_ids)) then raise exception 'Company is outside scope' using errcode='42501';end if;
 end if;
end $$;

create function public.access_purchase_transition(p_actor uuid,p_org text,p_case uuid,p_action text,p_revision bigint,p_digest text default null,p_reason text default null,p_source_revision bigint default 0)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare s public.access_resource_scopes; w public.access_purchase_workflows; permission_key text; self_approval boolean;
begin
 -- Same lock order as role changes and command dispatch. A revocation/transition race is serialized.
 select allow_self_approval into self_approval from public.access_organizations where id=p_org for update;
 if not found then raise exception 'Organization not found' using errcode='42501';end if;
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

create function public.access_dispatch_command(p_command uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare c public.access_command_authority; w public.access_purchase_workflows; org text;
begin
 select organization_id into org from public.access_command_authority where command_id=p_command;
 if org is null then raise exception 'Command authority missing' using errcode='42501';end if;
 perform 1 from public.access_organizations where id=org for update;
 select * into c from public.access_command_authority where command_id=p_command for update;
 if c.state<>'queued' then raise exception 'Command already issued or terminal; verify before retrying' using errcode='55000';end if;
 perform public.access_assert_permission(c.initiating_user_id,c.organization_id,c.permission,c.company_id);
 if c.case_id is not null then
   select * into w from public.access_purchase_workflows where case_id=c.case_id for update;
   if not found or w.state<>'approved' or w.approved_revision is distinct from c.approved_revision or w.financial_revision is distinct from c.approved_revision then
     raise exception 'Approved revision changed' using errcode='40001';end if;
   if c.permission<>'purchases.post' then raise exception 'Posting authority required' using errcode='42501';end if;
   if not exists(select 1 from public.access_resource_scopes where resource_type='case' and resource_id=c.case_id and organization_id=c.organization_id and company_id=c.company_id) then
     raise exception 'Command company differs from approved case' using errcode='42501';end if;
   update public.access_purchase_workflows set state='posting',command_id=p_command,revision=revision+1,updated_at=now() where case_id=c.case_id;
 end if;
 update public.access_command_authority set state='issued',issued_at=now() where command_id=p_command returning * into c;
 return to_jsonb(c);
end $$;

create function public.access_save_setting(p_actor uuid,p_org text,p_key text,p_revision bigint,p_value jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v public.access_organization_settings;
begin
 perform 1 from public.access_organizations where id=p_org for update;
 perform public.access_assert_permission(p_actor,p_org,'settings.manage',null);
 if p_key !~ '^[a-z][a-z0-9_-]{0,79}$' or pg_column_size(p_value)>1048576 then raise exception 'Invalid setting' using errcode='22023';end if;
 select * into v from public.access_organization_settings where organization_id=p_org and setting_key=p_key for update;
 if coalesce(v.revision,0)<>p_revision then raise exception 'Stale settings revision' using errcode='40001';end if;
 insert into public.access_organization_settings(organization_id,setting_key,value) values(p_org,p_key,p_value)
 on conflict(organization_id,setting_key) do update set value=excluded.value,revision=access_organization_settings.revision+1,updated_at=now() returning * into v;
 insert into public.access_audit(organization_id,actor_id,action,target_id,revision,details) values(p_org,p_actor,'settings.update',p_key,v.revision,'{}');
 return to_jsonb(v);
end $$;

create function public.access_member_work(p_actor uuid,p_org text,p_member uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare work_count bigint; queued_count bigint; issued_count bigint;
begin
 perform public.access_assert_permission(p_actor,p_org,'team.manage',null);
 if not exists(select 1 from public.access_members where organization_id=p_org and user_id=p_member) then raise exception 'Member not found' using errcode='42501';end if;
 select count(*) into work_count from public.access_purchase_workflows w join public.access_resource_scopes s on s.resource_type='case' and s.resource_id=w.case_id
 where s.organization_id=p_org and s.creator_user_id=p_member and w.state<>'posted';
 select count(*) filter(where state='queued'),count(*) filter(where state in ('issued','uncertain')) into queued_count,issued_count
 from public.access_command_authority where organization_id=p_org and initiating_user_id=p_member;
 return jsonb_build_object('openPurchases',work_count,'queuedCommands',queued_count,'issuedCommands',issued_count);
end $$;

-- Read-only preflight: missing optional legacy tables are reported, not dereferenced.
-- No automatic name-based company matching or fabricated historical approvals.
create function public.access_mapping_report() returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare result jsonb:='[]'; item record; total bigint; mapped bigint;
begin
 for item in select * from (values ('packet_cases','case'),('bank_statement_imports','bank_import'),('bank_accounts','bank_account'),('debit_note_proposals','proposal'),('tally_connections','connection')) as x(table_name,resource_type) loop
   if to_regclass('public.'||item.table_name) is null then
     result:=result||jsonb_build_array(jsonb_build_object('table',item.table_name,'exists',false));continue;
   end if;
   execute format('select count(*),count(s.resource_id) filter(where s.company_id is not null) from public.%I r left join public.access_resource_scopes s on s.resource_id=r.id and s.resource_type=$1',item.table_name)
   into total,mapped using item.resource_type;
   result:=result||jsonb_build_array(jsonb_build_object('table',item.table_name,'exists',true,'total',total,'mapped',mapped,'unresolved',total-mapped));
 end loop;
 return jsonb_build_object('resources',result,'sharingEnabled',exists(select 1 from public.access_organizations where sharing_enabled));
end $$;

-- All saved financial input changes participate in the same lock boundary, including service jobs.
create function public.access_guard_purchase_edit() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
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
   if found and w.state<>'draft' then raise exception 'Return submitted work before editing financial details' using errcode='55000';end if;
   update public.access_resource_scopes set source_revision=source_revision+1 where resource_type='case' and resource_id=cid;
   update public.access_purchase_workflows set revision=revision+1,financial_revision=financial_revision+1,financial_digest=repeat('0',64),updated_at=now() where case_id=cid;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
-- Dispatch is guarded at the database boundary, so polling workers and socket workers
-- cannot bypass it by using another claim path. Legacy unmapped organizations are unchanged.
create function public.access_guard_command_claim() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare c public.access_command_authority; shared boolean; org text;
begin
 if new.status is not distinct from old.status then return new;end if;
 select * into c from public.access_command_authority where command_id=new.id;
 org:=coalesce(c.organization_id,to_jsonb(new)->>'organization_id');
 select sharing_enabled into shared from public.access_organizations where id=org;
 if c.command_id is null then
   if coalesce(shared,false) and new.status='claimed' then raise exception 'Initiating user authority is required' using errcode='42501';end if;
   return new;
 end if;
 if new.status='claimed' then
   perform public.access_dispatch_command(new.id);
 elsif new.status='queued' and c.state in ('issued','uncertain') then
   raise exception 'Issued ERP writes require verification, not automatic retry' using errcode='55000';
 elsif new.status in ('completed','succeeded') and c.state in ('issued','uncertain') then
   update public.access_command_authority set state='completed',completed_at=now() where command_id=new.id;
   update public.access_purchase_workflows set state='posted',revision=revision+1,updated_at=now() where command_id=new.id and state='posting';
 elsif new.status='failed' and c.state='issued' then
   update public.access_command_authority set state='uncertain' where command_id=new.id;
 end if;
 return new;
end $$;
do $$ declare table_name text;begin
 foreach table_name in array array['packet_documents','purchase_invoice_tally_postings'] loop
   if to_regclass('public.'||table_name) is not null then
     execute format('create trigger access_financial_edit before insert or update or delete on public.%I for each row execute function public.access_guard_purchase_edit()',table_name);
   end if;
 end loop;
 if to_regclass('public.tally_bridge_commands') is not null then
   execute 'create trigger access_command_claim before update on public.tally_bridge_commands for each row execute function public.access_guard_command_claim()';
 end if;
end $$;
revoke all on function public.access_assert_permission(uuid,text,text,uuid),public.access_purchase_transition(uuid,text,uuid,text,bigint,text,text,bigint),public.access_dispatch_command(uuid),public.access_save_setting(uuid,text,text,bigint,jsonb),public.access_guard_purchase_edit() from public,anon,authenticated;
grant execute on function public.access_assert_permission(uuid,text,text,uuid),public.access_purchase_transition(uuid,text,uuid,text,bigint,text,text,bigint),public.access_dispatch_command(uuid),public.access_save_setting(uuid,text,text,bigint,jsonb),public.access_guard_purchase_edit() to service_role;
revoke all on function public.access_guard_command_claim() from public,anon,authenticated;
grant execute on function public.access_guard_command_claim() to service_role;
revoke all on function public.access_member_work(uuid,text,uuid),public.access_mapping_report() from public,anon,authenticated;
grant execute on function public.access_member_work(uuid,text,uuid),public.access_mapping_report() to service_role;
commit;
