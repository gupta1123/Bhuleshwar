-- Kalika only. Manual application required. This does NOT activate team sharing.
begin;
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
commit;
