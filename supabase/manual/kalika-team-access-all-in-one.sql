-- KALIKA TEAM & ACCESS: single-run bundle of 21 migrations.
-- TARGET ONLY: ktpaupxmlbtpjgvigmpb (Kalika). NEVER Gajkesari.
-- Run this entire file in the Kalika Supabase SQL Editor as database operator.
-- Existing Kalika application and bank-local-v2 prerequisites must be present.
-- Intended for a database with NONE of these Team & Access migrations applied.
-- Do NOT run the individual 21 files afterward. Keep this outside migrations/.
-- Originals preserved; only their transaction wrappers are replaced by one wrapper.
-- All statements roll back together if any statement fails. No automatic sharing activation.
-- Does not provision users or record Supabase CLI migration history.
-- Review project, back up first, and retain the complete success/error output.
begin;
set local lock_timeout='5s';
do $bundle_preflight$
begin
 if to_regclass('public.access_organizations') is not null then
  raise exception 'Team & Access already exists. Do not rerun this bundle; inspect migration state first.';
 end if;
end
$bundle_preflight$;

-- SECTION 1/21: 20260904145334_team_access_foundation.sql
-- Source SHA256: cc581d8fefa9f80a4a470dcd67baedf0098e0a7a656661321e21d0b9688c0883
-- Kalika only. Manual application required. This does NOT activate team sharing.

set local lock_timeout='5s';
create table public.access_organizations (
 id text primary key, name text not null check(length(name) between 1 and 120),
 revision bigint not null default 1, sharing_enabled boolean not null default false constraint access_sharing_requires_enforcement check(not sharing_enabled),
 allow_self_approval boolean not null default false, created_at timestamptz not null default now()
);
create table public.access_permissions (key text primary key);
insert into public.access_permissions select m||'.'||a from unnest(array['purchases','bank','discounts','followups']) m cross join unnest(array['view','prepare','submit','approve','post','export','recycle','delete']) a;
insert into public.access_permissions values ('team.manage'),('roles.manage'),('settings.manage'),('connections.manage');
create table public.access_roles (
 id uuid primary key default gen_random_uuid(), organization_id text not null references public.access_organizations,
 name text not null check(length(btrim(name)) between 1 and 80), template_key text,
 permissions text[] not null default '{}', revision bigint not null default 1, archived boolean not null default false,
 unique(organization_id,id), unique(organization_id,name), unique(organization_id,template_key)
);
create table public.access_companies (
 id uuid primary key default gen_random_uuid(), organization_id text not null references public.access_organizations,
 name text not null, erp_identity text not null, branch_identity text,
 unique(organization_id,id),unique(organization_id,erp_identity)
);
create table public.access_members (
 organization_id text not null references public.access_organizations, user_id uuid not null references auth.users,
 role_id uuid not null, display_name text not null, email text not null,
 status text not null default 'active' check(status in ('active','suspended')),
 is_owner boolean not null default false, all_companies boolean not null default false,
 company_ids uuid[] not null default '{}', modules text[] not null default '{}',
 must_change_password boolean not null default false, revision bigint not null default 1,
 primary key(organization_id,user_id),
 foreign key(organization_id,role_id) references public.access_roles(organization_id,id),
 check(modules <@ array['purchases','bank','discounts','followups']::text[])
);
create index access_members_user_idx on public.access_members(user_id,organization_id);
create index access_members_role_idx on public.access_members(organization_id,role_id);
create index access_members_team_idx on public.access_members(organization_id,display_name,user_id);
create table public.access_audit (
 id bigint generated always as identity primary key, organization_id text not null references public.access_organizations,
 actor_id uuid not null, action text not null, target_id text, revision bigint not null,
 details jsonb not null default '{}', created_at timestamptz not null default now()
);
create index access_audit_org_idx on public.access_audit(organization_id,id desc);

-- Only the backend can read/write these tables. The API must authenticate first.
-- No browser Data API path may change its own role or membership.
do $$ declare t text; begin
 foreach t in array array['access_organizations','access_permissions','access_roles','access_companies','access_members','access_audit'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select,insert,update,delete on public.%I to service_role',t);
 end loop;
end $$;
revoke update,delete on public.access_audit from service_role;
grant usage,select on sequence public.access_audit_id_seq to service_role;

create function public.access_snapshot(p_user uuid,p_org text default null) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
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
 'sharingEnabled',o.sharing_enabled,'allowSelfApproval',o.allow_self_approval,
 'member',to_jsonb(m),'role',to_jsonb(r),'organizations',choices,
 'companies',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) order by name),'[]') from public.access_companies where organization_id=p_org and (m.is_owner or m.all_companies or id=any(m.company_ids))));
end $$;

-- Serialized at organization level: scope checks, stale revisions, last-owner
-- protection and the audit revision commit together; no check-then-write race.
create function public.access_change(p_actor uuid,p_org text,p_action text,p_target text,p_expected bigint,p_data jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare o public.access_organizations; actor public.access_members; ar public.access_roles;
 target public.access_members; rr public.access_roles; perms text[]; companies uuid[]; mods text[];
 rid uuid; is_all boolean; wanted_status text; wanted_owner boolean; k text; result jsonb;
begin
 select * into o from public.access_organizations where id=p_org for update;
 if not found then raise exception 'Organization unavailable' using errcode='42501'; end if;
 if p_data ? '_accessRevision' and (p_data->>'_accessRevision')::bigint<>o.revision then raise exception 'Access changed; reload first' using errcode='40001'; end if;
 select * into actor from public.access_members where organization_id=p_org and user_id=p_actor and status='active' and not must_change_password;
 if not found then raise exception 'Access denied' using errcode='42501'; end if;
 select * into ar from public.access_roles where organization_id=p_org and id=actor.role_id and not archived;
 if not found then raise exception 'Access denied' using errcode='42501'; end if;
 if p_action in ('role.create','role.update','role.archive') then
  if not actor.is_owner and not ('roles.manage'=any(ar.permissions)) then raise exception 'Manage roles permission required' using errcode='42501'; end if;
  if p_action='role.create' then
   select * into rr from public.access_roles where organization_id=p_org and id=(p_data->>'cloneId')::uuid and not archived;
   if not found then raise exception 'Starting role unavailable' using errcode='22023'; end if;
   rid:=gen_random_uuid();
  else
   select * into rr from public.access_roles where organization_id=p_org and id=p_target::uuid for update;
   if not found then raise exception 'Role unavailable' using errcode='42501'; end if;
   if rr.revision<>p_expected then raise exception 'Role changed; reload first' using errcode='40001'; end if;
   if rr.template_key is not null then raise exception 'Clone a default role before editing it' using errcode='22023'; end if;
   if not actor.is_owner and exists(select 1 from public.access_members where organization_id=p_org and role_id=rr.id and (user_id=p_actor or is_owner or not(modules <@ actor.modules) or (all_companies and not actor.all_companies) or (not actor.all_companies and not(company_ids <@ actor.company_ids)))) then raise exception 'Role affects members outside your authority' using errcode='42501'; end if;
   rid:=rr.id;
  end if;
  perms:=case when p_data ? 'permissions' then array(select jsonb_array_elements_text(p_data->'permissions')) else rr.permissions end;
  if exists(select 1 from unnest(perms) p where not exists(select 1 from public.access_permissions where key=p)) then raise exception 'Unknown permission' using errcode='22023'; end if;
  foreach k in array perms loop
   if split_part(k,'.',1) in ('purchases','bank','discounts','followups') and split_part(k,'.',2)<>'view' and not (split_part(k,'.',1)||'.view'=any(perms)) then raise exception 'View permission required' using errcode='22023'; end if;
   if split_part(k,'.',2)='submit' and not (split_part(k,'.',1)||'.prepare'=any(perms)) then raise exception 'Prepare permission required' using errcode='22023'; end if;
  end loop;
  if not actor.is_owner and not (perms <@ ar.permissions) then raise exception 'Cannot grant permissions beyond your role' using errcode='42501'; end if;
  if p_action='role.archive' then
   if exists(select 1 from public.access_members where organization_id=p_org and role_id=rid) then raise exception 'Reassign all members before archiving' using errcode='22023'; end if;
   update public.access_roles set archived=true,revision=revision+1 where id=rid;
  elsif p_action='role.create' then
   insert into public.access_roles(id,organization_id,name,permissions) values(rid,p_org,btrim(p_data->>'name'),perms);
  else
   update public.access_roles set name=btrim(p_data->>'name'),permissions=perms,revision=revision+1 where id=rid;
  end if;
  result:=jsonb_build_object('id',rid);
 elsif p_action in ('member.update','owner.update') then
  if not actor.is_owner and not ('team.manage'=any(ar.permissions)) then raise exception 'Manage team permission required' using errcode='42501'; end if;
  select * into target from public.access_members where organization_id=p_org and user_id=p_target::uuid for update;
  if not found then raise exception 'Member unavailable' using errcode='42501'; end if;
  if target.revision<>p_expected then raise exception 'Member changed; reload first' using errcode='40001'; end if;
  if not actor.is_owner and (target.is_owner or target.user_id=p_actor or p_action='owner.update') then raise exception 'Cannot modify self or owner access' using errcode='42501'; end if;
  rid:=coalesce((p_data->>'roleId')::uuid,target.role_id);
  select * into rr from public.access_roles where id=rid and organization_id=p_org and not archived;
  if not found then raise exception 'Role unavailable' using errcode='22023'; end if;
  companies:=case when p_data ? 'companyIds' then array(select jsonb_array_elements_text(p_data->'companyIds')::uuid) else target.company_ids end;
  mods:=case when p_data ? 'modules' then array(select jsonb_array_elements_text(p_data->'modules')) else target.modules end;
  is_all:=coalesce((p_data->>'allCompanies')::boolean,target.all_companies);
  wanted_status:=coalesce(p_data->>'status',target.status);
  wanted_owner:=case when p_action='owner.update' then (p_data->>'isOwner')::boolean else target.is_owner end;
  if exists(select 1 from unnest(companies) c where not exists(select 1 from public.access_companies where id=c and organization_id=p_org)) then raise exception 'Invalid company scope' using errcode='22023'; end if;
  if not actor.is_owner and (not(rr.permissions <@ ar.permissions) or not(mods <@ actor.modules) or (is_all and not actor.all_companies) or (not actor.all_companies and not(companies <@ actor.company_ids))) then raise exception 'Cannot grant access beyond your scope' using errcode='42501'; end if;
  if target.is_owner and (not wanted_owner or wanted_status<>'active') and not exists(select 1 from public.access_members where organization_id=p_org and user_id<>target.user_id and is_owner and status='active') then raise exception 'Keep at least one active organization owner' using errcode='22023'; end if;
  update public.access_members set role_id=rid,company_ids=companies,modules=mods,all_companies=is_all,status=wanted_status,is_owner=wanted_owner,revision=revision+1 where organization_id=p_org and user_id=target.user_id;
  result:=jsonb_build_object('id',target.user_id);
 elsif p_action='policy.update' then
  if not actor.is_owner then raise exception 'Owner access required' using errcode='42501'; end if;
  if o.revision<>p_expected then raise exception 'Policy changed; reload first' using errcode='40001'; end if;
  update public.access_organizations set allow_self_approval=(p_data->>'allowSelfApproval')::boolean where id=p_org;
  result:='{}';
 else raise exception 'Unknown access operation' using errcode='22023'; end if;
 update public.access_organizations set revision=revision+1 where id=p_org returning revision into o.revision;
 insert into public.access_audit(organization_id,actor_id,action,target_id,revision,details)
 values(p_org,p_actor,p_action,coalesce(p_target,result->>'id'),o.revision,jsonb_build_object('changes',p_data));
 return result||jsonb_build_object('revision',o.revision);
end $$;
revoke all on function public.access_snapshot(uuid,text),public.access_change(uuid,text,text,text,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.access_snapshot(uuid,text),public.access_change(uuid,text,text,text,bigint,jsonb) to service_role;

create function public.access_provision(p_org text,p_org_name text,p_user uuid,p_name text,p_email text,p_role text,p_owner boolean,p_new_account boolean,p_templates jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare t jsonb; rid uuid; existing public.access_members;
begin
 insert into public.access_organizations(id,name) values(p_org,p_org_name) on conflict(id) do nothing;
 perform 1 from public.access_organizations where id=p_org for update;
 select * into existing from public.access_members where organization_id=p_org and user_id=p_user;
 if found then return jsonb_build_object('status','already-member','userId',p_user); end if;
 if not exists(select 1 from public.access_members where organization_id=p_org and status='active' and is_owner) and not p_owner then raise exception 'The first member must be an owner' using errcode='22023'; end if;
 for t in select * from jsonb_array_elements(p_templates) loop
  insert into public.access_roles(organization_id,name,template_key,permissions)
  values(p_org,t->>'name',t->>'key',array(select jsonb_array_elements_text(t->'permissions'))) on conflict(organization_id,template_key) do nothing;
 end loop;
 select id into rid from public.access_roles where organization_id=p_org and template_key=p_role and not archived;
 if rid is null then raise exception 'Unknown default role' using errcode='22023'; end if;
 insert into public.access_members(organization_id,user_id,role_id,display_name,email,is_owner,must_change_password)
 values(p_org,p_user,rid,p_name,p_email,p_owner,p_new_account);
 update public.access_organizations set revision=revision+1 where id=p_org;
 insert into public.access_audit(organization_id,actor_id,action,target_id,revision,details)
 select p_org,p_user,'internal.provision',p_user::text,revision,jsonb_build_object('owner',p_owner,'newAccount',p_new_account) from public.access_organizations where id=p_org;
 return jsonb_build_object('status','created-membership','userId',p_user,'scope','none');
end $$;
revoke all on function public.access_provision(text,text,uuid,text,text,text,boolean,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.access_provision(text,text,uuid,text,text,text,boolean,boolean,jsonb) to service_role;
create function public.access_password_changed(p_user uuid) returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare org text; rev bigint; begin
 for org in select organization_id from public.access_members where user_id=p_user order by organization_id loop
  perform 1 from public.access_organizations where id=org for update;
  update public.access_members set must_change_password=false,revision=revision+1 where organization_id=org and user_id=p_user;
  update public.access_organizations set revision=revision+1 where id=org returning revision into rev;
  insert into public.access_audit(organization_id,actor_id,action,target_id,revision) values(org,p_user,'account.password_changed',p_user::text,rev);
 end loop;
end $$;
revoke all on function public.access_password_changed(uuid) from public,anon,authenticated;
grant execute on function public.access_password_changed(uuid) to service_role;

-- SECTION 2/21: 20260904151552_team_access_workflow_authority.sql
-- Source SHA256: 0610bf1624aba81e5dd4b1c203259aedd04c43483b31a7b065f8aa5b26a8e0f2
-- Additive only. No hosted activation, inferred company mapping, or historical approval.

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

-- SECTION 3/21: 20260904160936_team_access_command_dispatch.sql
-- Source SHA256: 81258fc019fde13c4850aa395b2da9ccf2ca31889d1e3e8b6f027daf26608c30
-- Kalika only. Unapplied. Requires the foundation/workflow-authority migrations.
-- Does not enable sharing, change legacy company identity, or backfill approvals.

create function public.access_enqueue_purchase(
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
 if not found or w.state not in ('approved','posting','posted') then raise exception 'Purchase approval required' using errcode='55000';end if;
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
 if p_args->'p_tally_payload'->>'companyName' is distinct from (select name from public.access_companies where id=s.company_id and organization_id=p_org) then
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
 values(p_org,p_actor,'purchase.queue',p_case::text,w.revision,jsonb_build_object('commandId',cid,'approvedRevision',w.approved_revision));
 return cid;
end $$;

create function public.access_claim_next_command(p_connection uuid,p_installation text,p_generation bigint,p_bridge_version text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare cmd record; claimed record; n integer:=0;
begin
 if not exists(select 1 from public.tally_connections where id=p_connection and installation_id=p_installation and session_generation=p_generation and revoked_at is null) then
   raise exception 'Pairing session changed' using errcode='42501';
 end if;
 -- Issued writes are uncertain, never automatically retried after a missing response.
 update public.tally_bridge_commands b set status='failed',completed_at=now(),error='Response missing; verify the existing voucher before retrying.'
 where b.connection_id=p_connection and b.status='claimed' and b.claimed_at<now()-interval '2 minutes'
 and exists(select 1 from public.access_command_authority a where a.command_id=b.id and a.state in ('issued','uncertain'));
 update public.purchase_invoice_tally_postings p set status='verification_required',last_error='Tally response missing. Verify the existing voucher before retrying.'
 where p.status in ('queued','creating','approved') and exists(select 1 from public.access_command_authority a join public.tally_bridge_commands b on b.id=a.command_id where a.command_id=p.command_id and b.connection_id=p_connection and a.state='uncertain');
 for cmd in select b.* from public.tally_bridge_commands b where b.connection_id=p_connection and b.status='queued'
   and b.installation_id=p_installation and b.session_generation=p_generation and b.available_at<=now()
   order by b.priority desc,b.created_at,b.id limit 25 for update skip locked loop
   begin
     if not exists(select 1 from public.access_command_authority where command_id=cmd.id) then
       raise exception 'Command has no initiating-user authority' using errcode='42501';
     end if;
     if cmd.deadline_at is not null and cmd.deadline_at<now() then raise exception 'Command expired' using errcode='55000';end if;
     -- Existing trigger rechecks current membership/scope and the exact approved revision.
     update public.tally_bridge_commands set status='claimed',claimed_at=now(),attempts=attempts+1,bridge_version=p_bridge_version
       where id=cmd.id and status='queued' returning * into claimed;
     if found then return to_jsonb(claimed);end if;
   exception when insufficient_privilege or object_not_in_prerequisite_state or serialization_failure then
     -- The failed trigger is rolled back before cancellation. Move past revoked work.
     update public.tally_bridge_commands set status='canceled',completed_at=now(),error='Access, approval, session or deadline changed. Submit a new authorized request.' where id=cmd.id and status='queued';
     update public.access_command_authority set state='cancelled',completed_at=now() where command_id=cmd.id and state='queued';
     update public.purchase_invoice_tally_postings set status='ready_for_approval',command_id=null,last_error='Queued request cancelled because access or approval changed.'
       where command_id=cmd.id and status in ('approved','queued');
     n:=n+1;
   end;
 end loop;
 return null;
end $$;

revoke all on function public.access_enqueue_purchase(uuid,text,uuid,bigint,bigint,text,jsonb),public.access_claim_next_command(uuid,text,bigint,text) from public,anon,authenticated;
grant execute on function public.access_enqueue_purchase(uuid,text,uuid,bigint,bigint,text,jsonb),public.access_claim_next_command(uuid,text,bigint,text) to service_role;

-- SECTION 4/21: 20260904161958_team_access_resource_registration.sql
-- Source SHA256: 842292b6a78736c106760062b5b3ff4007e39ae492b2a7174a04a10a3f3532d9
-- Unapplied, Kalika only. Atomically register newly created scoped business rows.
-- Historical records remain unmapped until the reviewed mapping operation is used.

create function public.access_register_created_resource() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare row_data jsonb:=to_jsonb(new);org text;company uuid;actor uuid;kind text;permission text;
begin
 org:=row_data->>'access_organization_id';company:=(row_data->>'access_company_id')::uuid;
 if org is null and company is null then return new;end if;
 if org is null or company is null then raise exception 'Complete organization and company scope required' using errcode='23514';end if;
 kind:=case tg_table_name when 'packet_cases' then 'case' when 'bank_statement_imports' then 'bank_import' when 'bank_accounts' then 'bank_account' when 'debit_note_proposals' then 'proposal' end;
 permission:=case kind when 'case' then 'purchases.prepare' when 'bank_import' then 'bank.prepare' when 'bank_account' then 'bank.prepare' when 'proposal' then 'discounts.prepare' end;
 if kind is null then raise exception 'Unsupported resource registration' using errcode='22023';end if;
 actor:=(row_data->>'owner_user_id')::uuid;
 perform 1 from public.access_organizations where id=org for update;
 perform public.access_assert_permission(actor,org,permission,company);
 insert into public.access_resource_scopes(resource_type,resource_id,organization_id,company_id,creator_user_id,mapping_evidence)
 values(kind,(row_data->>'id')::uuid,org,company,actor,'Explicit company selection at authenticated resource creation');
 return new;
end $$;
do $$ declare t text;begin
 foreach t in array array['packet_cases','bank_statement_imports','bank_accounts','debit_note_proposals'] loop
  if to_regclass('public.'||t) is not null then execute format('create trigger access_register_resource after insert on public.%I for each row execute function public.access_register_created_resource()',t);end if;
 end loop;
end $$;
revoke all on function public.access_register_created_resource() from public,anon,authenticated;
grant execute on function public.access_register_created_resource() to service_role;

-- SECTION 5/21: 20260904164026_team_access_resource_deletion.sql
-- Source SHA256: 04725f1bc4dd477f94df60ad9ba7c2d652549e19b8bc2516068c0e08f1c66a40
-- Draft cleanup must not orphan authorization mappings. ERP/audit history is
-- retained; this is not an activation or historical backfill migration.

create function public.access_guard_resource_deletion() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare kind text:=tg_argv[0]; protected_posting boolean:=false;
begin
 if not exists(select 1 from public.access_resource_scopes where resource_type=kind and resource_id=old.id) then return old;end if;
 if kind='case' and to_regclass('public.purchase_invoice_tally_postings') is not null then
  execute 'select exists(select 1 from public.purchase_invoice_tally_postings where case_id=$1 and status in (''queued'',''creating'',''created'',''verification_required''))' into protected_posting using old.id;
 end if;
 if kind='case' and (protected_posting or exists(select 1 from public.access_purchase_workflows where case_id=old.id and state<>'draft')
   or exists(select 1 from public.access_command_authority where case_id=old.id)) then
   raise exception 'Keep the purchase and its approval or ERP history; recycle it instead' using errcode='55000';
 end if;
 return old;
end $$;
create function public.access_cleanup_deleted_resource() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare kind text:=tg_argv[0];
begin
 if kind='case' then delete from public.access_purchase_workflows where case_id=old.id and state='draft';end if;
 delete from public.access_resource_scopes where resource_type=kind and resource_id=old.id;
 return old;
end $$;
do $$ declare mapping text[];begin
 foreach mapping slice 1 in array array[['packet_cases','case'],['bank_statement_imports','bank_import'],['bank_accounts','bank_account'],['debit_note_proposals','proposal']] loop
  if to_regclass('public.'||mapping[1]) is not null then
   execute format('create trigger access_guard_resource_deletion before delete on public.%I for each row execute function public.access_guard_resource_deletion(%L)',mapping[1],mapping[2]);
   execute format('create trigger access_cleanup_deleted_resource after delete on public.%I for each row execute function public.access_cleanup_deleted_resource(%L)',mapping[1],mapping[2]);
  end if;
 end loop;
end $$;
-- Files and mismatch corrections are also inputs to a submitted purchase.
-- Protect the child-table paths used by uploads, reanalysis and correction APIs.
do $$ declare table_name text;begin
 foreach table_name in array array['packet_case_files','packet_mismatches'] loop
  if to_regclass('public.'||table_name) is not null then
   execute format('create trigger access_financial_edit before insert or update or delete on public.%I for each row execute function public.access_guard_purchase_edit()',table_name);
  end if;
 end loop;
end $$;
revoke all on function public.access_guard_resource_deletion(),public.access_cleanup_deleted_resource() from public,anon,authenticated;
grant execute on function public.access_guard_resource_deletion(),public.access_cleanup_deleted_resource() to service_role;

-- SECTION 6/21: 20260904170147_team_access_data_api_hardening.sql
-- Source SHA256: dbc2d91079032c993838cdf078e84529333808771ff3432ed4f7c963f0c6194d
-- Kalika only. Defines preparation/reporting functions; DOES NOT activate sharing
-- or change existing business-object privileges until explicitly invoked during
-- the reviewed activation transaction. Never invoke on another product project.

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

-- SECTION 7/21: 20260904171430_team_access_organization_defaults.sql
-- Source SHA256: f35557918fac7145ea4aef0d817bacd11af0820f0134eab30ea4b3eaf4bc0381
-- Kalika only; unapplied. No existing organization is modified automatically.

create function public.access_initialize_organization_settings(p_org text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare table_name text;columns text;projection text;rows_added bigint;result jsonb:='{}';
begin
 perform 1 from public.access_organizations where id=p_org for update;
 if not found then raise exception 'Organization unavailable' using errcode='42501';end if;
 foreach table_name in array array['field_settings','doc_type_settings','comparison_field_groups','purchase_accounting_settings'] loop
  if to_regclass('public.'||table_name) is null then
   result:=result||jsonb_build_object(table_name,'optional table absent');continue;
  end if;
  -- Copy the currently installed schema's configuration columns, including
  -- newer validation fields. Generate fresh IDs/timestamps, never copy identity.
  select string_agg(format('%I',a.attname),',' order by a.attnum),
   string_agg(case when a.attname='organization_id' then '$1' else format('source.%I',a.attname) end,',' order by a.attnum)
   into columns,projection from pg_attribute a
   where a.attrelid=to_regclass('public.'||table_name) and a.attnum>0 and not a.attisdropped
    and a.attgenerated='' and a.attidentity='' and a.attname not in ('id','created_at','updated_at');
  if not exists(select 1 from pg_attribute where attrelid=to_regclass('public.'||table_name) and attname='organization_id' and not attisdropped) then
   raise exception 'Settings table % lacks organization scope',table_name using errcode='23514';
  end if;
  execute format('insert into public.%1$I (%2$s) select %3$s from public.%1$I source where source.organization_id=''default'' on conflict do nothing',table_name,columns,projection) using p_org;
  get diagnostics rows_added=row_count;
  result:=result||jsonb_build_object(table_name,rows_added);
 end loop;
 return result;
end$$;
create function public.access_initialize_new_organization() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
begin perform public.access_initialize_organization_settings(new.id);return new;end$$;
create trigger access_organization_defaults after insert on public.access_organizations
 for each row execute function public.access_initialize_new_organization();
revoke all on function public.access_initialize_organization_settings(text),public.access_initialize_new_organization() from public,anon,authenticated;
grant execute on function public.access_initialize_organization_settings(text),public.access_initialize_new_organization() to service_role;

-- SECTION 8/21: 20260904172300_team_access_bank_account_identity.sql
-- Source SHA256: b0910c88eca7f1035c2fde5b746ee068f3e5bfab78f7f63165656492b3f48215
-- Kalika only; unapplied. Keep legacy uniqueness, add shared company identity.

set local lock_timeout='5s';
do $$declare constraint_row record;begin
 if to_regclass('public.bank_accounts') is null then return;end if;
 if not exists(select 1 from pg_attribute where attrelid='public.bank_accounts'::regclass and attname='account_number_normalized' and not attisdropped) then
  raise exception 'Bank account normalization migration is required';
 end if;
 for constraint_row in
  select c.conname from pg_constraint c where c.conrelid='public.bank_accounts'::regclass and c.contype='u'
   and (select array_agg(a.attname::text order by a.attname) from pg_attribute a where a.attrelid=c.conrelid and a.attnum=any(c.conkey))
       =array['account_number_normalized','owner_user_id']::text[]
 loop
  execute format('alter table public.bank_accounts drop constraint %I',constraint_row.conname);
 end loop;
 -- Conflicting existing mapped accounts fail this transaction for reconciliation;
 -- they are never silently merged or deleted.
 create unique index bank_accounts_legacy_identity on public.bank_accounts(owner_user_id,account_number_normalized)
  where access_organization_id is null and access_company_id is null;
 create unique index bank_accounts_team_identity on public.bank_accounts(access_organization_id,access_company_id,account_number_normalized)
  where access_organization_id is not null and access_company_id is not null;
 alter table public.bank_accounts add constraint bank_accounts_complete_access_scope
  check((access_organization_id is null)=(access_company_id is null)) not valid;
end$$;

-- SECTION 9/21: 20260904174716_team_access_dispatch_identity.sql
-- Source SHA256: 19eb23f5d5260eca9658d4144cc1531727e496316ab37bf7dbeb6d3271a695d4
-- Kalika only. Unapplied. Revalidate routing at the last boundary before execution.

create or replace function public.access_dispatch_command(p_command uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare c public.access_command_authority; w public.access_purchase_workflows;
 org text; cmd record; connection record;
begin
 select organization_id into org from public.access_command_authority where command_id=p_command;
 if org is null then raise exception 'Command authority missing' using errcode='42501';end if;
 perform 1 from public.access_organizations where id=org for update;
 select * into c from public.access_command_authority where command_id=p_command for update;
 if c.state<>'queued' then raise exception 'Command already issued or terminal; verify before retrying' using errcode='55000';end if;
 perform public.access_assert_permission(c.initiating_user_id,c.organization_id,c.permission,c.company_id);
 select * into cmd from public.tally_bridge_commands where id=p_command;
 if not found then raise exception 'Command missing' using errcode='42501';end if;
 select * into connection from public.tally_connections where id=cmd.connection_id for share;
 if not found or connection.revoked_at is not null
  or cmd.organization_id is distinct from c.organization_id
  or cmd.owner_user_id is distinct from connection.owner_user_id
  or cmd.installation_id is null or cmd.session_generation is null
  or cmd.installation_id is distinct from connection.installation_id
  or cmd.session_generation is distinct from connection.session_generation then
   raise exception 'Command pairing identity changed' using errcode='42501';
 end if;
 -- A GUID/year is mandatory, even when a company name happens to be unique.
 perform 1 from public.access_company_links where organization_id=c.organization_id
  and company_id=c.company_id and connection_id=cmd.connection_id
  and installation_id=cmd.installation_id and company_guid=cmd.company_guid
  and financial_year=cmd.financial_year for share;
 if not found then raise exception 'Command company mapping changed' using errcode='42501';end if;
 if cmd.deadline_at is not null and cmd.deadline_at<now() then
  raise exception 'Command expired' using errcode='55000';end if;
 if c.case_id is not null then
  select * into w from public.access_purchase_workflows where case_id=c.case_id for update;
  if not found or w.state<>'approved' or w.approved_revision is distinct from c.approved_revision
   or w.financial_revision is distinct from c.approved_revision then
   raise exception 'Approved revision changed' using errcode='40001';end if;
  if c.permission<>'purchases.post' then raise exception 'Posting authority required' using errcode='42501';end if;
  if not exists(select 1 from public.access_resource_scopes where resource_type='case' and resource_id=c.case_id
   and organization_id=c.organization_id and company_id=c.company_id) then
   raise exception 'Command company differs from approved case' using errcode='42501';end if;
  update public.access_purchase_workflows set state='posting',command_id=p_command,revision=revision+1,updated_at=now() where case_id=c.case_id;
 end if;
 update public.access_command_authority set state='issued',issued_at=now() where command_id=p_command returning * into c;
 return to_jsonb(c);
end $$;
revoke all on function public.access_dispatch_command(uuid) from public,anon,authenticated;
grant execute on function public.access_dispatch_command(uuid) to service_role;

-- SECTION 10/21: 20260904174928_team_access_command_visibility.sql
-- Source SHA256: 8273048d9a4f6e262b096b4b417d1c63fe09c901400709aa801126e6e9592e29
-- Backend-only projection. No client Data API access and no activation.

create view public.access_visible_commands with (security_invoker=true) as
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
 -- Document-job tokens, diagnostics and arbitrary future agent payloads are not
 -- exposed by this generic command API. They need their dedicated scoped APIs.
 where b.command_type in ('alter_ledger','create_ledger','sync_masters',
  'fetch_bank_ledgers','fetch_purchase_masters','post_bank_voucher',
  'fetch_customer_open_bills','create_debit_note','export_debit_note_pdf',
  'create_purchase_voucher','verify_bank_transaction');
revoke all on public.access_visible_commands from public,anon,authenticated;
grant select on public.access_visible_commands to service_role;

-- SECTION 11/21: 20260904175244_team_access_enqueue_reads.sql
-- Source SHA256: 93b043baac5fd440d22b372cbb37191852d71b4677fa4b1c7ac9314474d56edc
-- Additive, unapplied. Shared read jobs retain the connector owner's transport
-- identity while recording the actual user who requested the operation.

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

-- SECTION 12/21: 20260905064256_team_access_agent_reads.sql
-- Source SHA256: d6dac28d85b05de9aa348ef6d677f6a6ccafa142a30cb3ab08d3eb5e3ebb83dd
-- Kalika only. Additive and unapplied to hosted projects. Does not enable sharing.

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

-- SECTION 13/21: 20260905065432_team_access_purchase_completion.sql
-- Source SHA256: a323e33848fb490351ca79e9035bac38d9d219c9229e9c82e1599d83cf324f8a
-- Kalika only. Unapplied to hosted projects; team activation remains blocked.

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

-- SECTION 14/21: 20260905070944_team_access_dataset_masters.sql
-- Source SHA256: 4fe9a7d198f36677658e3ddae0e6c56e0569113d1b55ab287e5c0f0015c164e8
-- Kalika only; additive and unapplied. No name-based legacy cache backfill.

create table public.access_master_datasets (
 id uuid primary key default gen_random_uuid(),
 organization_id text not null, connection_id uuid not null, installation_id text not null,
 company_guid text not null, financial_year text not null,
 revision bigint not null default 0, updated_at timestamptz not null default now(),
 unique(organization_id,connection_id,installation_id,company_guid,financial_year),
 foreign key(organization_id,connection_id,installation_id,company_guid,financial_year)
 references public.access_company_links(organization_id,connection_id,installation_id,company_guid,financial_year)
);
create table public.access_dataset_masters (
 id uuid primary key default gen_random_uuid(), dataset_id uuid not null references public.access_master_datasets(id),
 master_type text not null check(master_type in ('ledger','group','stock_item','unit','voucher_type','gst_ledger','tax_ledger')),
 master_key text not null check(length(master_key) between 1 and 500), tally_name text not null check(length(tally_name) between 1 and 500),
 tally_guid text, parent_name text, gstin text, hsn_code text, unit_name text, tax_rate numeric,
 raw_payload jsonb not null default '{}', is_active boolean not null default true,
 last_synced_at timestamptz not null default now(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(dataset_id,master_type,master_key)
);
create index access_dataset_masters_listing on public.access_dataset_masters(dataset_id,master_type,tally_name,id);
create table public.access_dataset_mappings (
 id uuid primary key default gen_random_uuid(), dataset_id uuid not null references public.access_master_datasets(id),
 mapping_type text not null, source_key text not null, source_label text not null,
 target_master_type text not null, target_master_key text not null, target_master_name text not null,
 status text not null check(status in ('active','inactive')), notes text,
 revision bigint not null default 1, updated_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(dataset_id,mapping_type,source_key)
);
create table public.access_master_upload_receipts (
 command_id uuid primary key, dataset_id uuid not null references public.access_master_datasets(id),
 digest text not null, accepted integer not null, created_at timestamptz not null default now()
);
do $$ declare t text;begin
 foreach t in array array['access_master_datasets','access_dataset_masters','access_dataset_mappings','access_master_upload_receipts'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select,insert,update,delete on public.%I to service_role',t);
 end loop;
end $$;

-- The transport token proves the paired installation, not a user's financial
-- permission. Uploads also require an issued, scoped master-sync command.
create function public.access_save_master_snapshot(p_command uuid,p_connection uuid,p_token_hash text,p_identity jsonb,p_types text[],p_rows jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare c record; cmd record; a record; ds uuid; rec record; digest text; n integer; typ text; org text;
begin
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>20000 or pg_column_size(p_rows)>33554432
  or coalesce(cardinality(p_types),0) not between 1 and 7 or not p_types <@ array['ledger','group','stock_item','unit','voucher_type','gst_ledger','tax_ledger'] then
  raise exception 'Invalid bounded master snapshot' using errcode='22023';end if;
 select organization_id into org from public.access_command_authority where command_id=p_command;
 if org is null then raise exception 'Command authority required' using errcode='42501';end if;
 perform 1 from public.access_organizations where id=org for update;
 select * into a from public.access_command_authority where command_id=p_command for update;
 select * into cmd from public.tally_bridge_commands where id=p_command and connection_id=p_connection for update;
 if not found or cmd.command_type<>'sync_masters' or a.permission not in ('connections.manage','bank.prepare') or a.state not in ('issued','completed') then
  raise exception 'Issued master sync required' using errcode='42501';end if;
 if a.permission='bank.prepare' and not p_types <@ array['ledger','group'] then
  raise exception 'Bank refresh cannot upload unrelated masters' using errcode='42501';end if;
 if not coalesce(to_jsonb(p_types) <@ (cmd.payload->'requestedMasterTypes'),false) then
  raise exception 'Unrequested master types' using errcode='42501';end if;
 select * into c from public.tally_connections where id=p_connection for share;
 if not found or c.revoked_at is not null or c.bridge_token_hash is distinct from p_token_hash
  or cmd.organization_id is distinct from org or cmd.owner_user_id is distinct from c.owner_user_id
  or cmd.installation_id is distinct from c.installation_id or cmd.session_generation is distinct from c.session_generation
  or p_identity->>'organizationId' is distinct from org or p_identity->>'connectionId' is distinct from c.id::text
  or p_identity->>'ownerUserId' is distinct from c.owner_user_id::text or p_identity->>'installationId' is distinct from c.installation_id
  or p_identity->>'sessionGeneration' is distinct from c.session_generation::text
  or p_identity->>'companyGuid' is distinct from cmd.company_guid or p_identity->>'financialYear' is distinct from cmd.financial_year then
  raise exception 'Snapshot identity changed' using errcode='42501';end if;
 perform public.access_assert_permission(a.initiating_user_id,org,a.permission,a.company_id);
 perform 1 from public.access_company_links where organization_id=org and company_id=a.company_id and connection_id=c.id
  and installation_id=c.installation_id and company_guid=cmd.company_guid and financial_year=cmd.financial_year for share;
 if not found then raise exception 'Dataset mapping changed' using errcode='42501';end if;
 digest:=encode(sha256(convert_to(jsonb_build_object('types',p_types,'rows',p_rows)::text,'UTF8')),'hex');
 select * into rec from public.access_master_upload_receipts where command_id=p_command;
 if found then
  if rec.digest<>digest then raise exception 'Conflicting snapshot replay' using errcode='40001';end if;
  return jsonb_build_object('syncRunId',p_command,'accepted',rec.accepted,'datasetId',rec.dataset_id);
 end if;
 if cmd.status<>'claimed' then raise exception 'Master sync is no longer running' using errcode='55000';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r)<>'object' or not coalesce(r->>'master_type'=any(p_types),false)
  or coalesce(length(r->>'master_key'),0) not between 1 and 500 or coalesce(length(r->>'tally_name'),0) not between 1 and 500) then
  raise exception 'Invalid master rows' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) r group by r->>'master_type',r->>'master_key' having count(*)>1) then
  raise exception 'Duplicate master identity in snapshot' using errcode='22023';end if;
 insert into public.access_master_datasets(organization_id,connection_id,installation_id,company_guid,financial_year)
 values(org,c.id,c.installation_id,cmd.company_guid,cmd.financial_year)
 on conflict(organization_id,connection_id,installation_id,company_guid,financial_year) do update set updated_at=now()
 returning id into ds;
 -- All requested types switch atomically; untouched datasets/types remain intact.
 delete from public.access_dataset_masters where dataset_id=ds and master_type=any(p_types);
 insert into public.access_dataset_masters(dataset_id,master_type,master_key,tally_name,tally_guid,parent_name,gstin,hsn_code,unit_name,tax_rate,raw_payload)
 select ds,r.master_type,r.master_key,r.tally_name,r.tally_guid,r.parent_name,r.gstin,r.hsn_code,r.unit_name,r.tax_rate,coalesce(r.raw_payload,'{}')
 from jsonb_to_recordset(p_rows) as r(master_type text,master_key text,tally_name text,tally_guid text,parent_name text,gstin text,hsn_code text,unit_name text,tax_rate numeric,raw_payload jsonb);
 get diagnostics n=row_count;
 update public.access_master_datasets set revision=revision+1,updated_at=now() where id=ds;
 insert into public.access_master_upload_receipts(command_id,dataset_id,digest,accepted) values(p_command,ds,digest,n);
 return jsonb_build_object('syncRunId',p_command,'accepted',n,'datasetId',ds);
end $$;

create function public.access_save_dataset_mapping(p_actor uuid,p_org text,p_dataset uuid,p_revision bigint,p_mapping jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare ds record; link record; m record; master record; company text;
begin
 perform 1 from public.access_organizations where id=p_org for update;
 select * into ds from public.access_master_datasets where id=p_dataset and organization_id=p_org for update;
 if not found then raise exception 'Dataset unavailable' using errcode='42501';end if;
 select l.* into link from public.access_company_links l join public.tally_connections c on c.id=l.connection_id
  and c.installation_id=l.installation_id and c.revoked_at is null
 where l.organization_id=p_org and l.connection_id=ds.connection_id and l.installation_id=ds.installation_id
  and l.company_guid=ds.company_guid and l.financial_year=ds.financial_year for share of l,c;
 if not found then raise exception 'Dataset pairing changed' using errcode='42501';end if;
 perform public.access_assert_permission(p_actor,p_org,'connections.manage',link.company_id);
 if jsonb_typeof(p_mapping) is distinct from 'object' or pg_column_size(p_mapping)>8192
  or not coalesce(p_mapping->>'mapping_type'=any(array['supplier_gstin','buyer_gstin','item_hsn','item_description','gst_rate','purchase_ledger','tds_ledger','tcs_ledger','stock_unit','freight_ledger','round_off_ledger','voucher_type','bank_account_ledger','bank_narration_ledger','bank_category_ledger']),false)
  or coalesce(length(p_mapping->>'source_key'),0) not between 1 and 240 or coalesce(length(p_mapping->>'source_label'),0) not between 1 and 500
  or not coalesce(p_mapping->>'status'=any(array['active','inactive']),false) then
  raise exception 'Invalid mapping' using errcode='22023';end if;
 select * into master from public.access_dataset_masters where dataset_id=ds.id
  and master_type=p_mapping->>'target_master_type' and master_key=p_mapping->>'target_master_key' and is_active;
 if not found or master.tally_name is distinct from p_mapping->>'target_master_name' then
  raise exception 'Select a current master from this dataset' using errcode='40001';end if;
 select * into m from public.access_dataset_mappings where dataset_id=ds.id and mapping_type=p_mapping->>'mapping_type' and source_key=p_mapping->>'source_key' for update;
 if (found and m.revision is distinct from p_revision) or (not found and p_revision is distinct from 0::bigint) then
  raise exception 'Mapping changed; reload before saving' using errcode='40001';end if;
 insert into public.access_dataset_mappings(dataset_id,mapping_type,source_key,source_label,target_master_type,target_master_key,target_master_name,status,notes,updated_by)
 values(ds.id,p_mapping->>'mapping_type',p_mapping->>'source_key',p_mapping->>'source_label',master.master_type,master.master_key,master.tally_name,p_mapping->>'status',left(p_mapping->>'notes',1000),p_actor)
 on conflict(dataset_id,mapping_type,source_key) do update set source_label=excluded.source_label,target_master_type=excluded.target_master_type,
 target_master_key=excluded.target_master_key,target_master_name=excluded.target_master_name,status=excluded.status,notes=excluded.notes,
 updated_by=p_actor,updated_at=now(),revision=access_dataset_mappings.revision+1 returning * into m;
 insert into public.access_audit(organization_id,actor_id,action,target_id,revision,details)
 values(p_org,p_actor,'mapping.saved',m.id::text,m.revision,jsonb_build_object('datasetId',ds.id,'mappingType',m.mapping_type));
 return to_jsonb(m);
end $$;
revoke all on function public.access_save_master_snapshot(uuid,uuid,text,jsonb,text[],jsonb) from public,anon,authenticated;
revoke all on function public.access_save_dataset_mapping(uuid,text,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.access_save_master_snapshot(uuid,uuid,text,jsonb,text[],jsonb) to service_role;
grant execute on function public.access_save_dataset_mapping(uuid,text,uuid,bigint,jsonb) to service_role;
create function public.access_enqueue_master_sync(p_actor uuid,p_org text,p_company uuid,p_connection uuid,p_installation text,p_generation bigint,p_guid text,p_year text,p_types text[],p_permission text default 'connections.manage')
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare c record; cmd record; name text;
begin
 if coalesce(cardinality(p_types),0) not between 1 and 7 or not p_types <@ array['ledger','group','stock_item','unit','voucher_type','gst_ledger','tax_ledger'] then
  raise exception 'Select supported master types' using errcode='22023';end if;
 perform 1 from public.access_organizations where id=p_org for update;
 if p_permission is null or p_permission not in ('connections.manage','bank.prepare') or (p_permission='bank.prepare' and not p_types <@ array['ledger','group']) then
  raise exception 'Unsupported workflow master scope' using errcode='42501';end if;
 perform public.access_assert_permission(p_actor,p_org,p_permission,p_company);
 select * into c from public.tally_connections where id=p_connection for share;
 if not found or c.revoked_at is not null or c.installation_id is distinct from p_installation or c.session_generation is distinct from p_generation then
  raise exception 'Pairing changed' using errcode='42501';end if;
 perform 1 from public.access_company_links where organization_id=p_org and company_id=p_company and connection_id=p_connection
  and installation_id=p_installation and company_guid=p_guid and financial_year=p_year for share;
 if not found then raise exception 'Verified company mapping required' using errcode='42501';end if;
 select access_companies.name into name from public.access_companies where organization_id=p_org and id=p_company;
 insert into public.tally_bridge_commands(connection_id,owner_user_id,organization_id,installation_id,session_generation,company_guid,financial_year,
  command_type,status,priority,payload,protocol_version,job_class,max_attempts,deadline_at)
 values(c.id,c.owner_user_id,p_org,p_installation,p_generation,p_guid,p_year,'sync_masters','queued',25,
  jsonb_build_object('companyName',name,'companyGuid',p_guid,'financialYear',p_year,'requestedMasterTypes',p_types),1,'tally_read',1,now()+interval '5 minutes') returning * into cmd;
 insert into public.access_command_authority(command_id,organization_id,company_id,initiating_user_id,permission)
 values(cmd.id,p_org,p_company,p_actor,p_permission);
 return to_jsonb(cmd);
end $$;
revoke all on function public.access_enqueue_master_sync(uuid,text,uuid,uuid,text,bigint,text,text,text[],text) from public,anon,authenticated;
grant execute on function public.access_enqueue_master_sync(uuid,text,uuid,uuid,text,bigint,text,text,text[],text) to service_role;

-- SECTION 15/21: 20260905071727_team_access_bank_queue.sql
-- Source SHA256: 65eb5af62d086d9c0e13c7f8aabc70fcea367d2d05c8453fa3b31a3896a44888
-- Kalika only. Additive, unapplied; sharing remains gated.

create table public.access_bank_command_sources (
 command_id uuid primary key, transaction_id uuid, dataset_id uuid not null references public.access_master_datasets(id),
 source_digest text, created_at timestamptz not null default now()
);
create index access_bank_command_sources_transaction on public.access_bank_command_sources(transaction_id,command_id);
alter table public.access_bank_command_sources enable row level security;
revoke all on public.access_bank_command_sources from public,anon,authenticated;
grant select,insert,update,delete on public.access_bank_command_sources to service_role;
do $$ begin
 if to_regclass('public.bank_transactions') is not null then
 execute $view$create view public.access_bank_queue_transactions with(security_invoker=true) as
  select t.*,s.organization_id as queue_organization_id,s.company_id as queue_company_id
  from public.bank_transactions t
  join public.access_resource_scopes s on s.resource_type='bank_account' and s.resource_id=t.bank_account_id and s.company_id is not null
  where t.statement_import_id is null or exists(select 1 from public.access_resource_scopes i
   where i.resource_type='bank_import' and i.resource_id=t.statement_import_id and i.organization_id=s.organization_id and i.company_id=s.company_id)$view$;
 revoke all on public.access_bank_queue_transactions from public,anon,authenticated;
 grant select on public.access_bank_queue_transactions to service_role;
 end if;
end $$;
create function public.access_bank_source_digest(p_row jsonb) returns text language sql immutable security invoker set search_path=pg_catalog as $$
 select encode(sha256(convert_to(jsonb_build_object('account',p_row->'bank_account_id','import',p_row->'statement_import_id',
  'date',p_row->'transaction_date','debit',p_row->'debit_amount','credit',p_row->'credit_amount','type',p_row->'transaction_type',
  'description',p_row->'description','fingerprint',p_row->'fingerprint','reference',p_row->'reference_number')::text,'UTF8')),'hex')
$$;

create function public.access_enqueue_bank_batch(p_actor uuid,p_org text,p_company uuid,p_dataset uuid,p_generation bigint,p_commands jsonb,p_mappings jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare ds record; c record; l record; t record; account record; item jsonb; payload jsonb; cmd record;
 output jsonb:='[]'; m jsonb; target record; existing record; amount numeric; outgoing boolean; wanted text; name text; tid uuid;
begin
 if jsonb_typeof(p_commands) is distinct from 'array' or jsonb_array_length(p_commands) not between 1 and 200
  or pg_column_size(p_commands)>1048576 or jsonb_typeof(p_mappings) is distinct from 'array'
  or jsonb_array_length(p_mappings)>200 or pg_column_size(p_mappings)>1048576 then
  raise exception 'Invalid bounded bank batch' using errcode='22023';end if;
 perform 1 from public.access_organizations where id=p_org for update;
 perform public.access_assert_permission(p_actor,p_org,'bank.post',p_company);
 select * into ds from public.access_master_datasets where id=p_dataset and organization_id=p_org for share;
 if not found then raise exception 'Dataset not available' using errcode='42501';end if;
 select * into c from public.tally_connections where id=ds.connection_id for share;
 if not found or c.revoked_at is not null or c.installation_id is distinct from ds.installation_id or c.session_generation is distinct from p_generation then
  raise exception 'Pairing changed' using errcode='42501';end if;
 perform 1 from public.access_company_links where organization_id=p_org and company_id=p_company and connection_id=c.id
  and installation_id=c.installation_id and company_guid=ds.company_guid and financial_year=ds.financial_year for share;
 if not found then raise exception 'Company mapping changed' using errcode='42501';end if;
 select access_companies.name into name from public.access_companies where organization_id=p_org and id=p_company;
 for item in select value from jsonb_array_elements(p_commands) loop
  payload:=item->'payload';wanted:=item->>'command_type';
  if jsonb_typeof(payload) is distinct from 'object' or payload->>'companyName' is distinct from name
   or wanted not in ('create_ledger','post_bank_voucher','verify_bank_transaction') then
   raise exception 'Invalid bank command' using errcode='22023';end if;
  tid:=null;
  if wanted='create_ledger' then
   perform public.access_assert_permission(p_actor,p_org,'connections.manage',p_company);
   if coalesce(length(payload->>'name'),0) not between 1 and 500 or not exists(select 1 from public.access_dataset_masters
    where dataset_id=ds.id and master_type='group' and tally_name=payload->>'parentName' and is_active) then
    raise exception 'Invalid ledger creation' using errcode='22023';end if;
  else
   tid:=(payload->>'transactionId')::uuid;
   select * into t from public.bank_transactions where id=tid for update;
   if not found then raise exception 'Transaction unavailable' using errcode='42501';end if;
   select * into account from public.bank_accounts where id=t.bank_account_id for update;
   if not found or not exists(select 1 from public.access_resource_scopes where resource_type='bank_account' and resource_id=account.id
    and organization_id=p_org and company_id=p_company) or (t.statement_import_id is not null and not exists(select 1 from public.access_resource_scopes
     where resource_type='bank_import' and resource_id=t.statement_import_id and organization_id=p_org and company_id=p_company)) then
    raise exception 'Bank source belongs to another company' using errcode='42501';end if;
   if payload->>'bankAccountId' is distinct from account.id::text or payload->>'fingerprint' is distinct from t.fingerprint
    or payload->>'voucherDate' is distinct from t.transaction_date::text or payload->>'narration' is distinct from t.description
    or t.tally_status not in ('pending','failed','missing_in_tally','verification_failed') then
    raise exception 'Bank source changed; reload before posting' using errcode='40001';end if;
   if exists(select 1 from public.access_bank_command_sources s join public.access_command_authority a on a.command_id=s.command_id
    where s.transaction_id=tid and a.state in ('queued','issued','uncertain')) or exists(select 1 from public.bank_transaction_posting_log
     where bank_account_id=account.id and fingerprint=t.fingerprint and status in ('posted','verified','needs_tally_review')) then
    raise exception 'Transaction already active or needs verification' using errcode='40001';end if;
   outgoing:=coalesce(t.debit_amount,0)>0 and coalesce(t.credit_amount,0)=0;
   if not outgoing and not(coalesce(t.credit_amount,0)>0 and coalesce(t.debit_amount,0)=0) then
    raise exception 'Ambiguous transaction direction' using errcode='22023';end if;
   amount:=case when outgoing then t.debit_amount else t.credit_amount end;
   if (payload->>'amount')::numeric is distinct from amount or payload->>'expectedDirection' is distinct from (case when outgoing then 'outgoing' else 'incoming' end)
    or (wanted='post_bank_voucher' and ((payload->>'bankLedgerEntryIsDebit')::boolean is distinct from (not outgoing)
     or payload->>'voucherType' not in (case when outgoing then 'Payment' else 'Receipt' end,'Contra'))) then
    raise exception 'Voucher direction or amount disagrees with statement' using errcode='22023';end if;
   if not exists(select 1 from public.access_dataset_masters where dataset_id=ds.id and master_type='ledger' and tally_name=payload->>'bankLedgerName' and is_active) then
    raise exception 'Bank ledger not present in selected dataset' using errcode='40001';end if;
   if wanted='post_bank_voucher' and not exists(select 1 from public.access_dataset_masters where dataset_id=ds.id and master_type='ledger' and tally_name=payload->>'counterpartyLedgerName' and is_active)
    and not exists(select 1 from jsonb_array_elements(p_commands) x where x->>'command_type'='create_ledger' and x->'payload'->>'name'=payload->>'counterpartyLedgerName') then
    raise exception 'Counterparty ledger not present in selected dataset' using errcode='40001';end if;
   if jsonb_array_length(coalesce(payload->'billAllocations','[]'))>0 and abs((select sum((b->>'amount')::numeric) from jsonb_array_elements(payload->'billAllocations') b)-amount)>=0.005 then
    raise exception 'Bill allocation amount disagrees with statement' using errcode='22023';end if;
  end if;
  insert into public.tally_bridge_commands(connection_id,owner_user_id,organization_id,installation_id,session_generation,company_guid,financial_year,
   command_type,status,priority,payload,protocol_version,job_class,max_attempts,deadline_at)
  values(c.id,c.owner_user_id,p_org,c.installation_id,c.session_generation,ds.company_guid,ds.financial_year,wanted,'queued',
   case when wanted='create_ledger' then 30 else 20 end,payload||jsonb_build_object('companyGuid',ds.company_guid,'financialYear',ds.financial_year),
   1,case when wanted='verify_bank_transaction' then 'tally_read' else 'tally_write' end,1,now()+interval '10 minutes') returning * into cmd;
  insert into public.access_command_authority(command_id,organization_id,company_id,initiating_user_id,permission)
  values(cmd.id,p_org,p_company,p_actor,case when wanted='create_ledger' then 'connections.manage' else 'bank.post' end);
  insert into public.access_bank_command_sources(command_id,transaction_id,dataset_id,source_digest)
  values(cmd.id,tid,ds.id,case when tid is null then null else public.access_bank_source_digest(to_jsonb(t)) end);
  if tid is not null then
   insert into public.bank_transaction_posting_log(owner_user_id,bank_account_id,connection_id,source_transaction_id,fingerprint,transaction_date,
    reference_number,description,debit_amount,credit_amount,amount,voucher_type,bank_ledger_name,counterparty_ledger_name,command_id,status,error,result)
   values(account.owner_user_id,account.id,c.id,t.id,t.fingerprint,t.transaction_date,t.reference_number,t.description,t.debit_amount,t.credit_amount,amount,
    coalesce(payload->>'voucherType','Payment'),payload->>'bankLedgerName',payload->>'counterpartyLedgerName',cmd.id,'queued',null,'{}')
   on conflict(owner_user_id,bank_account_id,fingerprint) do update set command_id=excluded.command_id,status='queued',error=null,result='{}',connection_id=c.id,
    bank_ledger_name=excluded.bank_ledger_name,counterparty_ledger_name=excluded.counterparty_ledger_name;
   update public.bank_transactions set tally_status=case when wanted='verify_bank_transaction' then 'checking_in_tally' else 'pending' end,
    confirmed_ledger_name=coalesce(nullif(payload->>'counterpartyLedgerName',''),confirmed_ledger_name),ledger_mapping_source='queue_confirmation' where id=t.id;
   update public.bank_accounts set tally_connection_id=c.id,tally_ledger_name=payload->>'bankLedgerName' where id=account.id;
  end if;
  output:=output||jsonb_build_array(to_jsonb(cmd));
 end loop;
 for m in select value from jsonb_array_elements(p_mappings) loop
  if m->>'mapping_type' not in ('bank_account_ledger','bank_narration_ledger') then raise exception 'Invalid bank mapping' using errcode='22023';end if;
  select * into target from public.access_dataset_masters where dataset_id=ds.id and master_type='ledger' and tally_name=m->>'target_master_name' and is_active;
  -- Newly-created ledgers can be mapped after the next verified master sync.
  if not found then continue;end if;
  select * into existing from public.access_dataset_mappings where dataset_id=ds.id and mapping_type=m->>'mapping_type' and source_key=m->>'source_key' for update;
  if found and existing.target_master_key<>target.master_key then raise exception 'Shared mapping changed; review it before posting' using errcode='40001';end if;
  insert into public.access_dataset_mappings(dataset_id,mapping_type,source_key,source_label,target_master_type,target_master_key,target_master_name,status,notes,updated_by)
  values(ds.id,m->>'mapping_type',m->>'source_key',m->>'source_label','ledger',target.master_key,target.tally_name,'active',m->>'notes',p_actor)
  on conflict(dataset_id,mapping_type,source_key) do nothing;
 end loop;
 insert into public.access_audit(organization_id,actor_id,action,target_id,revision,details)
 values(p_org,p_actor,'bank.queued',ds.id::text,0,jsonb_build_object('commandCount',jsonb_array_length(output)));
 return output;
end $$;

-- Supplement existing dispatch authority with a source check, preserving its
-- owner/role/company/session checks. Trigger name sorts before the existing one.
create function public.access_check_bank_dispatch() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare s record; t record; a record;
begin
 if new.status='claimed' and old.status is distinct from new.status then
  select * into s from public.access_bank_command_sources where command_id=new.id;
  if found and s.transaction_id is not null then
   select * into t from public.bank_transactions where id=s.transaction_id for share;
   select * into a from public.access_command_authority where command_id=new.id;
   if t.id is null or s.source_digest is distinct from public.access_bank_source_digest(to_jsonb(t))
    or not exists(select 1 from public.access_resource_scopes where resource_type='bank_account' and resource_id=t.bank_account_id and organization_id=a.organization_id and company_id=a.company_id)
    or (t.statement_import_id is not null and not exists(select 1 from public.access_resource_scopes where resource_type='bank_import' and resource_id=t.statement_import_id and organization_id=a.organization_id and company_id=a.company_id)) then
    raise exception 'Bank source changed before dispatch' using errcode='42501';end if;
  end if;
 end if;
 return new;
end $$;
create trigger access_00_bank_dispatch before update of status on public.tally_bridge_commands for each row execute function public.access_check_bank_dispatch();
revoke all on function public.access_bank_source_digest(jsonb) from public,anon,authenticated;
revoke all on function public.access_enqueue_bank_batch(uuid,text,uuid,uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.access_check_bank_dispatch() from public,anon,authenticated;
grant execute on function public.access_bank_source_digest(jsonb) to service_role;
grant execute on function public.access_enqueue_bank_batch(uuid,text,uuid,uuid,bigint,jsonb,jsonb) to service_role;
grant execute on function public.access_check_bank_dispatch() to service_role;
create function public.access_complete_bank_command(p_command uuid,p_connection uuid,p_token_hash text,p_result jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare org text; a record; cmd record; c record; s record; t record; outcome text; digest text; ok boolean;
begin
 if jsonb_typeof(p_result) is distinct from 'object' or pg_column_size(p_result)>32768 or jsonb_typeof(p_result->'success') is distinct from 'boolean' then
  raise exception 'Invalid bank completion' using errcode='22023';end if;
 digest:=encode(sha256(convert_to(p_result::text,'UTF8')),'hex');ok:=(p_result->>'success')::boolean;outcome:=p_result->>'status';
 select organization_id into org from public.access_command_authority where command_id=p_command;
 if org is null then raise exception 'Command authority missing' using errcode='42501';end if;
 perform 1 from public.access_organizations where id=org for update;
 select * into a from public.access_command_authority where command_id=p_command for update;
 select * into cmd from public.tally_bridge_commands where id=p_command and connection_id=p_connection for update;
 select * into s from public.access_bank_command_sources where command_id=p_command;
 if s.command_id is null or cmd.id is null or cmd.command_type not in ('post_bank_voucher','verify_bank_transaction','create_ledger')
  or cmd.organization_id is distinct from org then raise exception 'Scoped bank command required' using errcode='42501';end if;
 select * into c from public.tally_connections where id=p_connection for share;
 if not found or c.revoked_at is not null or c.bridge_token_hash is distinct from p_token_hash or c.owner_user_id is distinct from cmd.owner_user_id
  or c.installation_id is distinct from cmd.installation_id or c.session_generation is distinct from cmd.session_generation then
  raise exception 'Result pairing changed' using errcode='42501';end if;
 if a.result_digest is not null then
  if a.result_digest<>digest then raise exception 'Conflicting bank result' using errcode='40001';end if;
  return to_jsonb(cmd);
 end if;
 if a.state not in ('issued','uncertain') or cmd.status not in ('claimed','failed') then raise exception 'Bank command was not issued' using errcode='55000';end if;
 if cmd.command_type='create_ledger' then
  if ok then
   insert into public.access_dataset_masters(dataset_id,master_type,master_key,tally_name,parent_name,raw_payload)
   values(s.dataset_id,'ledger','ledger:'||lower(regexp_replace(btrim(cmd.payload->>'name'),'\s+',' ','g')),cmd.payload->>'name',cmd.payload->>'parentName','{}')
   on conflict(dataset_id,master_type,master_key) do update set tally_name=excluded.tally_name,parent_name=excluded.parent_name,last_synced_at=now();
  end if;
 else
  if not coalesce(outcome=any(array['posted','verified','missing_in_tally','needs_tally_review','verification_failed']),false)
   or (cmd.command_type='post_bank_voucher' and outcome not in ('posted','needs_tally_review')) then
   raise exception 'Invalid terminal bank status' using errcode='22023';end if;
  select * into t from public.bank_transactions where id=s.transaction_id for update;
  if not found then raise exception 'Issued source is missing' using errcode='55000';end if;
  update public.bank_transactions set tally_status=outcome,tally_posted_at=case when outcome in ('posted','verified') then now() else null end,
   tally_voucher_id=case when outcome in ('posted','verified') then p_result->>'voucherId' else null end where id=t.id;
  update public.bank_transaction_posting_log set status=outcome,error=p_result->>'error',result=coalesce(p_result->'result','{}'),
   tally_voucher_id=case when outcome in ('posted','verified') then p_result->>'voucherId' else null end,
   tally_posted_at=case when outcome in ('posted','verified') then now() else null end
  where source_transaction_id=t.id and command_id=cmd.id and bank_account_id=t.bank_account_id and fingerprint=t.fingerprint;
  if not found then raise exception 'Issued posting log missing' using errcode='55000';end if;
 end if;
 update public.tally_bridge_commands set status=case when ok then 'succeeded' else 'failed' end,result=coalesce(p_result->'result','{}'),
  error=p_result->>'error',completed_at=now() where id=p_command returning * into cmd;
 update public.access_command_authority set result_digest=digest,completed_at=now(),state=case when outcome='needs_tally_review' or (not ok and cmd.command_type='create_ledger') then 'uncertain' else 'completed' end where command_id=p_command;
 insert into public.access_audit(organization_id,actor_id,action,target_id,revision,details)
 values(org,a.initiating_user_id,'bank.result',coalesce(s.transaction_id,p_command)::text,0,jsonb_build_object('commandId',p_command,'status',outcome,'resultDigest',digest));
 return to_jsonb(cmd);
end $$;
revoke all on function public.access_complete_bank_command(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.access_complete_bank_command(uuid,uuid,text,jsonb) to service_role;
create function public.access_guard_bank_source() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if (tg_op='DELETE' or public.access_bank_source_digest(to_jsonb(old)) is distinct from public.access_bank_source_digest(to_jsonb(new)))
  and exists(select 1 from public.access_bank_command_sources s join public.access_command_authority a on a.command_id=s.command_id
   where s.transaction_id=old.id and a.state in ('queued','issued','uncertain')) then
  raise exception 'This bank entry is queued or awaiting Tally verification' using errcode='55000';end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
do $$ begin if to_regclass('public.bank_transactions') is not null then
 create trigger access_bank_source_guard before update or delete on public.bank_transactions for each row execute function public.access_guard_bank_source();
end if;end $$;
revoke all on function public.access_guard_bank_source() from public,anon,authenticated;
grant execute on function public.access_guard_bank_source() to service_role;

-- SECTION 16/21: 20260905072804_team_access_bank_documents.sql
-- Source SHA256: 497ecfad4a5b6b94b57f7ac52724a2c4d9bd44795274d8ee0de11c238e1574fa
-- Kalika only. Requires the existing local-bank-v2 schema; never applies itself.

create table public.access_bank_document_jobs (
 job_id uuid primary key, import_id uuid not null, command_id uuid unique,
 organization_id text not null, company_id uuid not null, initiating_user_id uuid not null references auth.users(id),
 resource_type text not null default 'bank_import' check(resource_type='bank_import'),
 completed_digest text,
 foreign key(resource_type,import_id) references public.access_resource_scopes(resource_type,resource_id),
 foreign key(organization_id,company_id) references public.access_companies(organization_id,id)
);
create index access_bank_document_actor on public.access_bank_document_jobs(organization_id,initiating_user_id,job_id);
alter table public.access_bank_document_jobs enable row level security;
revoke all on public.access_bank_document_jobs from public,anon,authenticated;
grant select,insert,update,delete on public.access_bank_document_jobs to service_role;

create function public.access_assert_bank_document(p_job uuid) returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare scope record; identity jsonb;
begin
 select * into scope from public.access_bank_document_jobs where job_id=p_job;
 if not found then return;end if; -- Legacy jobs retain their original checks.
 perform 1 from public.access_organizations where id=scope.organization_id for update;
 perform public.access_assert_permission(scope.initiating_user_id,scope.organization_id,'bank.prepare',scope.company_id);
 if not exists(select 1 from public.access_resource_scopes where resource_type='bank_import' and resource_id=scope.import_id
  and organization_id=scope.organization_id and company_id=scope.company_id) then
  raise exception 'Document company scope changed' using errcode='42501';end if;
 if scope.command_id is not null and not exists(select 1 from public.tally_bridge_commands cmd join public.access_company_links l
  on l.organization_id=cmd.organization_id and l.connection_id=cmd.connection_id and l.installation_id=cmd.installation_id
  and l.company_guid=cmd.company_guid and l.financial_year=cmd.financial_year
  where cmd.id=scope.command_id and l.organization_id=scope.organization_id and l.company_id=scope.company_id) then
  raise exception 'Document dataset mapping changed' using errcode='42501';end if;
 if scope.command_id is null then
  select processing_meta#>'{selectedContext,accessDataset}' into identity from public.bank_statement_imports where id=scope.import_id;
  if not exists(select 1 from public.tally_connections c join public.access_company_links l
   on l.connection_id=c.id and l.installation_id=c.installation_id and l.organization_id=c.organization_id
   where c.id=(identity->>'connectionId')::uuid and c.revoked_at is null and c.installation_id=identity->>'installationId'
    and c.session_generation::text=identity->>'sessionGeneration' and l.organization_id=scope.organization_id
    and l.company_id=scope.company_id and l.company_guid=identity->>'companyGuid' and l.financial_year=identity->>'financialYear') then
   raise exception 'Document pairing or dataset changed' using errcode='42501';end if;
 end if;
end $$;

create function public.access_bank_local_create(p_actor uuid,p_org text,p_company uuid,p_import_id uuid,p_job_id uuid,p_command_id uuid,p_identity jsonb,
 p_file jsonb,p_upload jsonb,p_result_url text,p_result_token text,p_global_limit integer default 1)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare created jsonb; link record; link_count integer;
begin
 perform 1 from public.access_organizations where id=p_org for update;
 perform public.access_assert_permission(p_actor,p_org,'bank.prepare',p_company);
 if p_identity->>'organizationId' is distinct from p_org then raise exception 'Wrong document organization' using errcode='42501';end if;
 select count(*) into link_count from public.access_company_links where organization_id=p_org and company_id=p_company
  and connection_id=(p_identity->>'connectionId')::uuid and installation_id=p_identity->>'installationId' and company_guid=p_identity->>'companyGuid'
  and left(financial_year,4)=left(p_identity->>'financialYear',4) and right(financial_year,2)=right(p_identity->>'financialYear',2);
 if link_count<>1 then raise exception 'One verified document dataset required' using errcode='42501';end if;
 select * into link from public.access_company_links where organization_id=p_org and company_id=p_company
  and connection_id=(p_identity->>'connectionId')::uuid and installation_id=p_identity->>'installationId' and company_guid=p_identity->>'companyGuid'
  and left(financial_year,4)=left(p_identity->>'financialYear',4) and right(financial_year,2)=right(p_identity->>'financialYear',2) for share;
 created:=public.bank_local_v2_create(p_import_id,p_job_id,p_command_id,p_identity,p_file,p_upload,p_result_url,p_result_token,p_global_limit);
 if created->>'state'<>'created' then return created;end if;
 -- Financial record attribution is the initiating teammate, not the paired PC owner.
 update public.bank_statement_imports set owner_user_id=p_actor where id=p_import_id;
 update public.bank_statement_extraction_jobs set owner_user_id=p_actor where id=p_job_id;
 update public.bank_local_pipeline_runs set owner_user_id=p_actor where job_id=p_job_id;
 update public.tally_bridge_commands set financial_year=link.financial_year where id=p_command_id;
 insert into public.access_resource_scopes(resource_type,resource_id,organization_id,company_id,creator_user_id,mapping_evidence)
 values('bank_import',p_import_id,p_org,p_company,p_actor,'Authenticated local document creation; verified connector dataset');
 insert into public.access_bank_document_jobs(job_id,import_id,command_id,organization_id,company_id,initiating_user_id)
 values(p_job_id,p_import_id,p_command_id,p_org,p_company,p_actor);
 insert into public.access_command_authority(command_id,organization_id,company_id,initiating_user_id,permission)
 values(p_command_id,p_org,p_company,p_actor,'bank.prepare');
 select jsonb_set(created,'{import}',to_jsonb(i)) into created from public.bank_statement_imports i where id=p_import_id;
 return created;
end $$;

alter function public.bank_local_v2_claim(uuid,uuid,jsonb,text,text,integer) rename to bank_local_v2_claim_legacy;
create function public.bank_local_v2_claim(p_job_id uuid,p_command_id uuid,p_identity jsonb,p_source_hash text,p_context_hash text,p_ledger_count integer)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 perform public.access_assert_bank_document(p_job_id);
 return public.bank_local_v2_claim_legacy(p_job_id,p_command_id,p_identity,p_source_hash,p_context_hash,p_ledger_count);
end $$;
alter function public.bank_local_v2_finalize(uuid,jsonb,text,jsonb) rename to bank_local_v2_finalize_legacy;
create function public.bank_local_v2_finalize(p_job_id uuid,p_identity jsonb,p_digest text,p_prepared jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare result jsonb; scope record; i record; ids uuid[]; normalized text; was_completed boolean;
begin
 perform public.access_assert_bank_document(p_job_id);
 perform 1 from public.bank_statement_extraction_jobs where id=p_job_id for update;
 select state='completed' into was_completed from public.bank_local_pipeline_runs where job_id=p_job_id;
 result:=public.bank_local_v2_finalize_legacy(p_job_id,p_identity,p_digest,p_prepared);
 if was_completed then return result;end if;
 select * into scope from public.access_bank_document_jobs where job_id=p_job_id;
 if found and result->>'state'='completed' then
  select * into i from public.bank_statement_imports where id=scope.import_id for update;
  normalized:=upper(regexp_replace(coalesce(i.extracted_account_number,''),'[^a-zA-Z0-9]','','g'));
  select array_agg(id) into ids from (select b.id from public.bank_accounts b join public.access_resource_scopes s
   on s.resource_type='bank_account' and s.resource_id=b.id and s.organization_id=scope.organization_id and s.company_id=scope.company_id
   where b.account_number_normalized=nullif(normalized,'') order by b.id limit 5) matched;
  update public.bank_statement_imports set bank_account_id=case when cardinality(ids)=1 then ids[1] else null end,
   status=case when status='manual_review_required' then status when cardinality(ids)>1 then 'needs_account_selection' else 'ready_to_review' end where id=i.id;
 end if;
 return result;
end $$;
alter function public.bank_local_v2_checkpoint(uuid,jsonb,text,jsonb) rename to bank_local_v2_checkpoint_legacy;
create function public.bank_local_v2_checkpoint(p_job_id uuid,p_identity jsonb,p_digest text,p_prepared jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 perform public.access_assert_bank_document(p_job_id);
 return public.bank_local_v2_checkpoint_legacy(p_job_id,p_identity,p_digest,p_prepared);
end $$;
-- Job-token status uses the paired owner; the financial job retains its creator.
create or replace function public.bank_local_v2_status(p_command_id uuid,p_owner_id uuid,p_connection_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.bank_local_pipeline_runs; status text;
begin
 select * into r from public.bank_local_pipeline_runs where command_id=p_command_id
  and identity->>'ownerUserId'=p_owner_id::text and identity->>'connectionId'=p_connection_id::text;
 if not found then raise exception 'Document scope mismatch' using errcode='42501';end if;
 perform public.access_assert_bank_document(r.job_id);
 perform public.bank_local_v2_assert_identity(r.identity);
 select j.status into status from public.bank_statement_extraction_jobs j where id=r.job_id;
 return jsonb_build_object('state',case when status in ('cancelled','failed') then status else r.state end,'jobId',r.job_id,'importId',r.import_id,'revision',r.revision,'digest',r.result_digest);
end $$;
create function public.access_cancel_bank_document(p_actor uuid,p_org text,p_job uuid) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare scope record; r record;
begin
 select * into scope from public.access_bank_document_jobs where job_id=p_job and organization_id=p_org;
 if not found then raise exception 'Document not found' using errcode='42501';end if;
 perform 1 from public.access_organizations where id=p_org for update;
 perform public.access_assert_permission(p_actor,p_org,'bank.prepare',scope.company_id);
 select * into r from public.bank_local_pipeline_runs where job_id=p_job;
 return public.bank_local_v2_cancel(p_job,r.owner_user_id,p_org);
end $$;
revoke all on function public.access_assert_bank_document(uuid) from public,anon,authenticated;
revoke all on function public.access_bank_local_create(uuid,text,uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,text,text,integer) from public,anon,authenticated;
revoke all on function public.access_cancel_bank_document(uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.bank_local_v2_claim(uuid,uuid,jsonb,text,text,integer) from public,anon,authenticated;
revoke all on function public.bank_local_v2_finalize(uuid,jsonb,text,jsonb) from public,anon,authenticated;
revoke all on function public.bank_local_v2_checkpoint(uuid,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.access_assert_bank_document(uuid) to service_role;
grant execute on function public.access_bank_local_create(uuid,text,uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,text,text,integer) to service_role;
grant execute on function public.access_cancel_bank_document(uuid,text,uuid) to service_role;
grant execute on function public.bank_local_v2_claim(uuid,uuid,jsonb,text,text,integer) to service_role;
grant execute on function public.bank_local_v2_finalize(uuid,jsonb,text,jsonb) to service_role;
grant execute on function public.bank_local_v2_checkpoint(uuid,jsonb,text,jsonb) to service_role;
create function public.access_bank_backend_create(p_actor uuid,p_org text,p_company uuid,p_scope jsonb,p_import jsonb,p_job_result jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare i public.bank_statement_imports; j uuid:=gen_random_uuid(); c record;
begin
 perform 1 from public.access_organizations where id=p_org for update;
 perform public.access_assert_permission(p_actor,p_org,'bank.prepare',p_company);
 select * into c from public.tally_connections where id=(p_scope->>'connectionId')::uuid for share;
 if not found or c.revoked_at is not null or c.installation_id is distinct from p_scope->>'installationId'
  or c.session_generation::text is distinct from p_scope->>'sessionGeneration' then raise exception 'Pairing changed' using errcode='42501';end if;
 if not exists(select 1 from public.access_company_links where organization_id=p_org and company_id=p_company and connection_id=c.id
  and installation_id=c.installation_id and company_guid=p_scope->>'companyGuid' and financial_year=p_scope->>'financialYear') then
  raise exception 'Verified document dataset required' using errcode='42501';end if;
 if p_import->>'owner_user_id' is distinct from p_actor::text or coalesce(length(p_import->>'storage_path'),0)=0
  or p_import#>>'{processing_meta,selectedContext,localParsing,mode}'='local_agent' then raise exception 'Invalid backend document' using errcode='22023';end if;
 insert into public.bank_statement_imports(owner_user_id,original_file_name,storage_bucket,storage_path,storage_asset_id,content_sha256,mime_type,size_bytes,status,processing_meta)
 values(p_actor,p_import->>'original_file_name',p_import->>'storage_bucket',p_import->>'storage_path',(p_import->>'storage_asset_id')::uuid,p_import->>'content_sha256',
  p_import->>'mime_type',(p_import->>'size_bytes')::bigint,'processing',jsonb_set(p_import->'processing_meta','{selectedContext,accessDataset}',p_scope)) returning * into i;
 insert into public.bank_statement_extraction_jobs(id,import_id,owner_user_id,status,progress,stage,result)
 values(j,i.id,p_actor,'queued',5,'Statement uploaded',p_job_result);
 insert into public.access_resource_scopes(resource_type,resource_id,organization_id,company_id,creator_user_id,mapping_evidence)
 values('bank_import',i.id,p_org,p_company,p_actor,'Authenticated backend document creation; verified connector dataset');
 insert into public.access_bank_document_jobs(job_id,import_id,organization_id,company_id,initiating_user_id) values(j,i.id,p_org,p_company,p_actor);
 return to_jsonb(i);
end $$;
revoke all on function public.access_bank_backend_create(uuid,text,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.access_bank_backend_create(uuid,text,uuid,jsonb,jsonb,jsonb) to service_role;

-- Backend-parsed documents use the same atomic publish boundary as local jobs.
create function public.access_bank_backend_finalize(p_job uuid,p_attempt integer,p_worker text,p_import jsonb,p_rows jsonb,p_result jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare s public.access_bank_document_jobs; j public.bank_statement_extraction_jobs; i public.bank_statement_imports;
 d text; row_value jsonb; n integer:=0; account_ids uuid[]; normalized text; chosen uuid; next_status text;
begin
 select * into s from public.access_bank_document_jobs where job_id=p_job;
 if not found or s.command_id is not null then raise exception 'Backend document job required' using errcode='42501';end if;
 perform public.access_assert_bank_document(p_job);
 select * into j from public.bank_statement_extraction_jobs where id=p_job for update;
 select * into i from public.bank_statement_imports where id=s.import_id for update;
 if j.import_id is distinct from i.id or j.owner_user_id is distinct from s.initiating_user_id then
  raise exception 'Document attribution changed' using errcode='42501';end if;
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>10000 or octet_length(p_rows::text)>16777216 then
  raise exception 'Invalid preview size' using errcode='22023';end if;
 d:=encode(sha256(convert_to(jsonb_build_array(p_attempt,p_import,p_rows,p_result)::text,'UTF8')),'hex');
 if s.completed_digest is not null then
  if s.completed_digest=d then return j.result;end if;
  raise exception 'Completed document result differs' using errcode='40001';end if;
 if j.status<>'running' or j.attempt_count is distinct from p_attempt or j.locked_by is distinct from p_worker then
  raise exception 'Document lease is no longer current' using errcode='40001';end if;
 normalized:=upper(regexp_replace(coalesce(p_import->>'extracted_account_number',''),'[^a-zA-Z0-9]','','g'));
 select array_agg(a.id order by a.id) into account_ids from public.bank_accounts a join public.access_resource_scopes r
  on r.resource_type='bank_account' and r.resource_id=a.id where r.organization_id=s.organization_id and r.company_id=s.company_id
  and normalized<>'' and a.account_number_normalized=normalized;
 chosen:=case when cardinality(account_ids)=1 then account_ids[1] else null end;
 next_status:=case when p_import->>'status'='manual_review_required' then 'manual_review_required'
  when cardinality(account_ids)>1 then 'needs_account_selection' else 'ready_to_review' end;
 delete from public.bank_statement_import_preview_transactions where import_id=i.id;
 for row_value in select value from jsonb_array_elements(p_rows) loop
  n:=n+1;
  insert into public.bank_statement_import_preview_transactions
   select (jsonb_populate_record(null::public.bank_statement_import_preview_transactions,
    jsonb_build_object('category','unknown','additional_charges','[]'::jsonb,'raw_payload','{}'::jsonb)||row_value||
    jsonb_build_object('id',gen_random_uuid(),'import_id',i.id,'owner_user_id',s.initiating_user_id,'row_index',n,'created_at',now(),'updated_at',now()))).*;
 end loop;
 update public.bank_statement_imports set bank_account_id=chosen,status=next_status,
  statement_period_start=(p_import->>'statement_period_start')::date,statement_period_end=(p_import->>'statement_period_end')::date,
  extracted_bank_name=p_import->>'extracted_bank_name',extracted_account_number=p_import->>'extracted_account_number',
  extracted_account_holder_name=p_import->>'extracted_account_holder_name',extracted_ifsc_code=p_import->>'extracted_ifsc_code',
  processing_meta=jsonb_set(coalesce(p_import->'processing_meta','{}'),'{selectedContext}',i.processing_meta->'selectedContext') where id=i.id;
 update public.bank_statement_extraction_jobs set status='succeeded',progress=100,stage='Completed',error=null,
  result=p_result||jsonb_build_object('status',next_status,'transactionCount',n),locked_at=null,locked_by=null,finished_at=now(),updated_at=now()
  where id=j.id returning * into j;
 update public.access_bank_document_jobs set completed_digest=d where job_id=j.id;
 return j.result;
end $$;
revoke all on function public.access_bank_backend_finalize(uuid,integer,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.access_bank_backend_finalize(uuid,integer,text,jsonb,jsonb,jsonb) to service_role;

-- SECTION 17/21: 20260905074815_team_access_discount_writes.sql
-- Source SHA256: 81b56f2f4bb6535bf971117d6fb53b813ede91a4362f865564fa086bb428f147
-- Kalika only. Optional historical proposal tables are checked at execution.

create table public.access_discount_commands(
 command_id uuid primary key,proposal_id uuid not null,source_digest text not null,
 organization_id text not null,company_id uuid not null,
 foreign key(organization_id,company_id) references public.access_companies(organization_id,id)
);
create index access_discount_commands_proposal on public.access_discount_commands(proposal_id,command_id);
alter table public.access_discount_commands enable row level security;
revoke all on public.access_discount_commands from public,anon,authenticated;
grant select,insert,update,delete on public.access_discount_commands to service_role;

create function public.access_discount_digest(p jsonb) returns text language sql immutable set search_path=pg_catalog as $$
 select encode(sha256(convert_to(jsonb_build_array(p->'party_ledger_name',p->'linked_invoice_number',p->'linked_invoice_date',
 p->'recoverable_amount',p->'debit_note_date',p->'narration',p->'gst_mode',p->'reason_code',p->'connection_id',p->'company_name',
 p#>'{customer_snapshot,sourceSalesLedgerName}')::text,'UTF8')),'hex')
$$;

create function public.access_enqueue_discount(p_actor uuid,p_org text,p_company uuid,p_connection uuid,p_installation text,
 p_generation bigint,p_guid text,p_year text,p_payload jsonb,p_proposal uuid default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare c record; p record; cmd public.tally_bridge_commands; cname text; payload jsonb; pid uuid:=coalesce(p_proposal,gen_random_uuid()); amount numeric;
begin
 if to_regclass('public.debit_note_proposals') is null then raise exception 'Discount schema is unavailable' using errcode='55000';end if;
 perform 1 from public.access_organizations where id=p_org for update;
 perform public.access_assert_permission(p_actor,p_org,'discounts.post',p_company);
 if p_proposal is not null then perform public.access_assert_permission(p_actor,p_org,'discounts.approve',p_company);end if;
 select * into c from public.tally_connections where id=p_connection for share;
 if not found or c.revoked_at is not null or c.organization_id is distinct from p_org or c.installation_id is distinct from p_installation
  or c.session_generation is distinct from p_generation then raise exception 'Pairing changed' using errcode='42501';end if;
 if not exists(select 1 from public.access_company_links where organization_id=p_org and company_id=p_company and connection_id=c.id
  and installation_id=p_installation and company_guid=p_guid and financial_year=p_year) then raise exception 'Verified discount dataset required' using errcode='42501';end if;
 select name into cname from public.access_companies where organization_id=p_org and id=p_company;
 if p_proposal is not null then
  if not exists(select 1 from public.access_resource_scopes where resource_type='proposal' and resource_id=pid and organization_id=p_org and company_id=p_company) then
   raise exception 'Proposal is outside company scope' using errcode='42501';end if;
  select * into p from public.debit_note_proposals where id=pid for update;
  if not found or p.connection_id is distinct from c.id or p.company_name is distinct from cname or p.status not in ('draft','pending_approval','failed') then
   raise exception 'Proposal changed or cannot be queued' using errcode='40001';end if;
  payload:=jsonb_build_object('partyLedgerName',p.party_ledger_name,'partyGstin',p.party_gstin,'linkedInvoiceNumber',p.linked_invoice_number,
   'linkedInvoiceDate',p.linked_invoice_date,'voucherDate',p.debit_note_date,'amount',p.recoverable_amount,
   'salesLedgerName',p.customer_snapshot->>'sourceSalesLedgerName','referenceNumber',left('DN-CD-'||coalesce(p.linked_invoice_number,p.id::text),120),
   'narration',p.narration,'reasonCode',p.reason_code,'gstMode',p.gst_mode);
 else
  if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>65536 then raise exception 'Invalid discount payload' using errcode='22023';end if;
  payload:=p_payload - array['xml','tallyUrl','ownerUserId','organizationId','agentIdentity','companyName','proposalId'];
 end if;
 amount:=(payload->>'amount')::numeric;
 if amount is null or amount<=0 or amount>100000000000 or coalesce(length(payload->>'partyLedgerName'),0) not between 1 and 500
  or coalesce(length(payload->>'linkedInvoiceNumber'),0) not between 1 and 120 or coalesce(length(payload->>'salesLedgerName'),0) not between 1 and 500
  or coalesce(length(payload->>'referenceNumber'),0) not between 1 and 120 or (payload->>'voucherDate')::date is null then
  raise exception 'Incomplete discount accounting data' using errcode='22023';end if;
 if exists(select 1 from public.access_discount_commands s join public.access_command_authority a on a.command_id=s.command_id
  join public.debit_note_proposals old on old.id=s.proposal_id where s.organization_id=p_org and s.company_id=p_company
  and lower(old.party_ledger_name)=lower(payload->>'partyLedgerName') and lower(old.linked_invoice_number)=lower(payload->>'linkedInvoiceNumber')
  and a.state in ('queued','issued','uncertain')) then raise exception 'An existing debit note needs completion or verification' using errcode='40001';end if;
 if p_proposal is null then
  if exists(select 1 from public.debit_note_proposals old join public.access_resource_scopes r on r.resource_type='proposal' and r.resource_id=old.id
   where r.organization_id=p_org and r.company_id=p_company and old.status='created_in_tally' and old.connection_id=c.id
    and old.customer_snapshot->>'agentReference'=payload->>'referenceNumber') then
   raise exception 'This discount reversal was already created' using errcode='40001';end if;
  insert into public.debit_note_proposals(id,owner_user_id,connection_id,company_name,financial_year,party_ledger_name,party_gstin,
   linked_invoice_number,linked_invoice_date,original_invoice_amount,recoverable_amount,reason_code,narration,gst_mode,debit_note_date,
   status,customer_snapshot,party_email,party_phone,party_contact_person,party_address,cash_discount_rule_name,discount_deadline,receipt_date,amount_received)
  values(pid,p_actor,c.id,cname,p_year,payload->>'partyLedgerName',payload->>'partyGstin',payload->>'linkedInvoiceNumber',(payload->>'linkedInvoiceDate')::date,
   (payload#>>'{sourceProposal,originalInvoiceAmount}')::numeric,amount,coalesce(payload->>'reasonCode','cash_discount_expired'),payload->>'narration',
   coalesce(payload->>'gstMode','finance_review'),(payload->>'voucherDate')::date,'draft',
   coalesce(payload#>'{sourceProposal,customerSnapshot}','{}')||jsonb_build_object('sourceSalesLedgerName',payload->>'salesLedgerName','agentReference',payload->>'referenceNumber'),
   payload#>>'{sourceProposal,partyEmail}',payload#>>'{sourceProposal,partyPhone}',payload#>>'{sourceProposal,partyContactPerson}',payload#>>'{sourceProposal,partyAddress}',
   payload#>>'{sourceProposal,cashDiscountRuleName}',(payload#>>'{sourceProposal,discountDeadline}')::date,(payload#>>'{sourceProposal,receiptDate}')::date,
   (payload#>>'{sourceProposal,amountReceived}')::numeric) returning * into p;
  insert into public.access_resource_scopes(resource_type,resource_id,organization_id,company_id,creator_user_id,mapping_evidence)
   values('proposal',pid,p_org,p_company,p_actor,'Authenticated scoped discount revalidation');
 end if;
 payload:=(payload-'sourceProposal')||jsonb_build_object('proposalId',pid,'companyName',cname,'financialYear',p_year,'adjustOriginalInvoice',false);
 insert into public.tally_bridge_commands(connection_id,owner_user_id,organization_id,installation_id,session_generation,company_guid,financial_year,
  command_type,status,priority,protocol_version,job_class,deadline_at,max_attempts,payload)
 values(c.id,c.owner_user_id,p_org,p_installation,p_generation,p_guid,p_year,'create_debit_note','queued',35,1,'write',now()+interval '5 minutes',1,payload) returning * into cmd;
 insert into public.access_command_authority(command_id,organization_id,company_id,initiating_user_id,permission)
  values(cmd.id,p_org,p_company,p_actor,'discounts.post');
 insert into public.access_discount_commands values(cmd.id,pid,public.access_discount_digest(to_jsonb(p)),p_org,p_company);
 update public.debit_note_proposals set status='queued_in_tally',tally_command_id=cmd.id,approval_by=p_actor,approved_at=now(),last_error=null,updated_at=now() where id=pid;
 insert into public.access_audit(organization_id,actor_id,action,target_id,revision,details) values(p_org,p_actor,'discount.queued',pid::text,
  (select revision from public.access_organizations where id=p_org),jsonb_build_object('commandId',cmd.id));
 return jsonb_build_object('command',to_jsonb(cmd),'proposalId',pid);
end $$;

create function public.access_check_discount_dispatch() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare s record; p record;
begin
 if new.command_type<>'create_debit_note' or new.status<>'claimed' or old.status='claimed' then return new;end if;
 select * into s from public.access_discount_commands where command_id=new.id;
 if not found then return new;end if;
 select * into p from public.debit_note_proposals where id=s.proposal_id for share;
 if not found or public.access_discount_digest(to_jsonb(p)) is distinct from s.source_digest or p.status<>'queued_in_tally'
  or p.tally_command_id is distinct from new.id or not exists(select 1 from public.access_resource_scopes where resource_type='proposal'
   and resource_id=p.id and organization_id=s.organization_id and company_id=s.company_id) then
  raise exception 'Discount source changed before dispatch' using errcode='42501';end if;
 return new;
end $$;
create trigger access_00_discount_dispatch before update of status on public.tally_bridge_commands for each row execute function public.access_check_discount_dispatch();

create function public.access_complete_discount(p_command uuid,p_connection uuid,p_token_hash text,p_result jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare a public.access_command_authority; s public.access_discount_commands; c record; cmd public.tally_bridge_commands; digest text; ok boolean;
begin
 if jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>32768 then raise exception 'Invalid result' using errcode='22023';end if;
 select * into s from public.access_discount_commands where command_id=p_command;
 if not found then raise exception 'Issued discount required' using errcode='42501';end if;
 perform 1 from public.access_organizations where id=s.organization_id for update;
 select * into a from public.access_command_authority where command_id=p_command for update;
 select * into cmd from public.tally_bridge_commands where id=p_command and connection_id=p_connection for update;
 select * into c from public.tally_connections where id=p_connection for share;
 if a.command_id is null or a.permission<>'discounts.post' or a.organization_id<>s.organization_id or a.company_id<>s.company_id
  or cmd.id is null or cmd.command_type<>'create_debit_note' or c.id is null or c.revoked_at is not null or c.bridge_token_hash is distinct from p_token_hash
  or cmd.owner_user_id is distinct from c.owner_user_id or cmd.installation_id is distinct from c.installation_id or cmd.session_generation is distinct from c.session_generation then
  raise exception 'Invalid issued discount pairing' using errcode='42501';end if;
 digest:=encode(sha256(convert_to(p_result::text,'UTF8')),'hex');
 if a.result_digest is not null then
  if a.result_digest<>digest then raise exception 'Conflicting discount result' using errcode='40001';end if;
  return to_jsonb(cmd);
 end if;
 if a.state not in ('issued','uncertain') or cmd.status not in ('claimed','failed') then raise exception 'Discount not issued' using errcode='55000';end if;
 ok:=coalesce((p_result->>'success')::boolean,false) and coalesce(length(p_result->>'voucherId'),0)>0
  and not coalesce((p_result->>'possibleDuplicateInTally')::boolean,false);
 update public.debit_note_proposals set status=case when ok then 'created_in_tally' else 'failed' end,
  tally_voucher_id=p_result->>'voucherId',tally_voucher_guid=p_result->>'voucherGuid',tally_voucher_number=p_result->>'voucherNumber',
  tally_voucher_date=(p_result->>'voucherDate')::date,tally_open_reference_name=p_result->>'openReferenceName',
  remaining_recoverable_amount=case when ok then recoverable_amount else remaining_recoverable_amount end,
  created_in_tally_at=case when ok then now() else created_in_tally_at end,last_synced_from_tally_at=case when ok then now() else last_synced_from_tally_at end,
  last_error=case when ok then null else coalesce(left(p_result->>'error',2000),'Verify the existing Tally voucher before retrying.') end,updated_at=now()
  where id=s.proposal_id and tally_command_id=p_command;
 if not found then raise exception 'Issued proposal missing' using errcode='55000';end if;
 update public.tally_bridge_commands set status=case when ok then 'succeeded' else 'failed' end,result=p_result,
  error=case when ok then null else coalesce(left(p_result->>'error',2000),'Verify the existing Tally voucher before retrying.') end,completed_at=now()
  where id=p_command returning * into cmd;
 update public.access_command_authority set state=case when ok then 'completed' else 'uncertain' end,result_digest=digest,completed_at=now() where command_id=p_command;
 insert into public.access_audit(organization_id,actor_id,action,target_id,revision,details) values(s.organization_id,a.initiating_user_id,'discount.result',s.proposal_id::text,
  (select revision from public.access_organizations where id=s.organization_id),
  jsonb_build_object('commandId',p_command,'verified',ok,'resultDigest',digest));
 return to_jsonb(cmd);
end $$;
revoke all on function public.access_discount_digest(jsonb),public.access_check_discount_dispatch(),public.access_enqueue_discount(uuid,text,uuid,uuid,text,bigint,text,text,jsonb,uuid),public.access_complete_discount(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.access_discount_digest(jsonb),public.access_check_discount_dispatch(),public.access_enqueue_discount(uuid,text,uuid,uuid,text,bigint,text,text,jsonb,uuid),public.access_complete_discount(uuid,uuid,text,jsonb) to service_role;

-- SECTION 18/21: 20260905082719_team_access_client_operations.sql
-- Source SHA256: fe0c2aa69128b6c380f2292d86969dd5b43e50e2ea213b2834d830f14f807e29
-- Kalika only. Prepared for manual application; does not activate sharing.

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

-- SECTION 19/21: 20260905084439_team_access_client_activation.sql
-- Source SHA256: 44f085c1798985a4b379a9a94630768f40023de8800ac16c254d78e6b25c3c88
-- Kalika only. Preparation only: applying this file does NOT enable sharing.
-- The migration operator must complete the client-release checklist before
-- invoking activation; HTTP/service-role callers cannot activate it.

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

-- SECTION 20/21: 20260906114629_team_access_scoped_agent_sync.sql
-- Source SHA256: dfdf9a48c11f396c12bfa51a3193b37728fe07718db9cf0fce8d43647cb1e564
-- Kalika only. Does not activate sharing or change existing records.

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

-- SECTION 21/21: 20260908190000_team_access_purchase_command_payload_durability.sql
-- Source SHA256: 2f833dbd646863afd10b46e18c3fc3d67dadce5c9f7dfdb060883b4a16693982
-- Retain the frozen, approved canonical voucher after an uncertain or completed
-- team-access write. This allows read-back recovery without reconstructing or
-- recalculating the voucher from mutable case data.

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
-- Schema preparation complete. Review mappings/memberships before enabling enforcement/sharing.
