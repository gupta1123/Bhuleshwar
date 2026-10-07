-- Kalika only; additive and unapplied. No name-based legacy cache backfill.
begin;
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
commit;
