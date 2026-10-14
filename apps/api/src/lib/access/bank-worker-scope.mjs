import {QueuedAccessDenied} from './queued-authority.mjs';

/** Resolve only server-recorded dataset identity, never a display-name match. */
export async function bankWorkerDataset(db, job, access, selected) {
  if (!access) return null;
  const identity = selected?.accessDataset;
  if (!identity || identity.organizationId !== access.organization_id || identity.companyId !== access.company_id ||
      !identity.connectionId || !identity.installationId || !identity.companyGuid || !identity.financialYear) throw new QueuedAccessDenied();
  const checked = await db.rpc('access_assert_bank_document', {p_job:job.id});
  if (checked.error) throw checked.error;
  const connection = await db.from('tally_connections').select('id,organization_id,installation_id,session_generation,revoked_at')
    .eq('id',identity.connectionId).maybeSingle();
  if (connection.error) throw connection.error;
  const c = connection.data;
  if (!c || c.revoked_at || c.organization_id !== access.organization_id || c.installation_id !== identity.installationId ||
      c.session_generation !== identity.sessionGeneration) throw new QueuedAccessDenied();
  const link = await db.from('access_company_links').select('company_id').eq('organization_id',access.organization_id)
    .eq('company_id',access.company_id).eq('connection_id',c.id).eq('installation_id',c.installation_id)
    .eq('company_guid',identity.companyGuid).eq('financial_year',identity.financialYear).maybeSingle();
  if (link.error) throw link.error;
  if (!link.data) throw new QueuedAccessDenied();
  const dataset = await db.from('access_master_datasets').select('id').eq('organization_id',access.organization_id)
    .eq('connection_id',c.id).eq('installation_id',c.installation_id).eq('company_guid',identity.companyGuid)
    .eq('financial_year',identity.financialYear).maybeSingle();
  if (dataset.error) throw dataset.error;
  // Fresh complete ledger inputs can be supplied without a persisted snapshot.
  return {identity,datasetId:dataset.data?.id || null};
}

export function bankMasterQuery(db, select, owner, connection, dataset, company) {
  let query = db.from(dataset ? 'access_dataset_masters' : 'tally_masters').select(select);
  query = dataset ? query.eq('dataset_id',dataset) : query.eq('owner_user_id',owner).eq('connection_id',connection);
  if (!dataset && company) query = query.eq('company_name',company);
  return query;
}
