-- Kalika only. Unapplied. Revalidate routing at the last boundary before execution.
begin;
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
commit;
