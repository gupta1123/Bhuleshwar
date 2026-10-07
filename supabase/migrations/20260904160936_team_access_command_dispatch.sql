-- Kalika only. Unapplied. Requires the foundation/workflow-authority migrations.
-- Does not enable sharing, change legacy company identity, or backfill approvals.
begin;

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
commit;
