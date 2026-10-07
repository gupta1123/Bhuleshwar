import {
  bindConnectionCompanyLink,
  chooseAutomaticCompanyTarget,
  restoreConnectionCompanyLinks,
  type ApplicationCompanyIdentity,
} from '@/lib/access/connection-company-links';
import { accessFailureResponse } from '@/lib/access/failures';
import { withTeamAccess } from '@/lib/access/route-boundary';
import { AccessError, requirePermission } from '@/lib/access/server';
import { jsonWithCors, optionsWithCors } from '@/lib/api/cors';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

type ObservedCompany = { companyGuid: string; companyName: string; financialYear: string; isActive: boolean };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

function normalizedText(value: unknown, maximum = 500) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function collectObservedCompanies(
  datasets: Array<Record<string, unknown>>,
  snapshot: unknown,
  activeCompanyName: unknown,
) {
  const companies = new Map<string, ObservedCompany>();
  const add = (row: Record<string, unknown>) => {
    const companyGuid = normalizedText(row.company_guid ?? row.guid);
    const companyName = normalizedText(row.company_name ?? row.companyName ?? row.name);
    const financialYear = normalizedText(row.financial_year ?? row.financialYear, 80);
    if (!companyGuid || !companyName || !financialYear) return;
    companies.set(`${companyGuid}\u0000${financialYear}`, {
      companyGuid, companyName, financialYear,
      isActive: normalizedText(activeCompanyName).toLowerCase() === companyName.toLowerCase() || row.isActive === true,
    });
  };
  for (const row of datasets) add(row);
  for (const row of Array.isArray(snapshot) ? snapshot : []) {
    if (row && typeof row === 'object') add(row as Record<string, unknown>);
  }
  return [...companies.values()];
}

async function loadManagerConnection(request: Request, id: string) {
  const access = await requirePermission(request, 'connections.manage');
  if (!access.member.all_companies) {
    throw new AccessError('Only a company administrator with access to all companies can link a new Tally identity.', 403);
  }
  const db = createSupabaseAdminClient();
  const connectionResult = await db.from('tally_connections')
    .select('id,organization_id,owner_user_id,installation_id,last_company_name,last_companies_snapshot')
    .eq('id', id).eq('organization_id', access.organizationId)
    .eq('owner_user_id', access.member.user_id).is('revoked_at', null).maybeSingle();
  if (connectionResult.error) throw connectionResult.error;
  const connection = connectionResult.data;
  if (!connection?.installation_id) throw new AccessError('Tally connection not found.', 404);
  const restored = await restoreConnectionCompanyLinks({
    db,
    organizationId: access.organizationId,
    installationId: connection.installation_id,
    connectionId: id,
  });
  const [datasetResult, linkResult] = await Promise.all([
    db.from('tally_agent_datasets').select('company_guid,company_name,financial_year')
      .eq('organization_id', access.organizationId).eq('connection_id', id)
      .eq('installation_id', connection.installation_id).limit(1000),
    db.from('access_company_links').select('company_id,company_guid,financial_year,verified_at,evidence')
      .eq('organization_id', access.organizationId).eq('connection_id', id)
      .eq('installation_id', connection.installation_id).limit(1000),
  ]);
  if (datasetResult.error || linkResult.error || (datasetResult.data?.length || 0) >= 1000 || (linkResult.data?.length || 0) >= 1000) {
    throw new AccessError('Observed Tally companies could not be verified completely.', 503);
  }
  const observed = collectObservedCompanies(
    (datasetResult.data || []) as Array<Record<string, unknown>>,
    connection.last_companies_snapshot,
    connection.last_company_name,
  );
  return { access, db, connection, observed, links: linkResult.data || [], mappingConflicts: restored.conflicts };
}

async function automaticallyLinkActiveCompanies(input: Awaited<ReturnType<typeof loadManagerConnection>>) {
  const { access, db, connection, observed, mappingConflicts } = input;
  const companyResult = await db.from('access_companies').select('id,name,erp_identity')
    .eq('organization_id', access.organizationId).limit(1000);
  if (companyResult.error || (companyResult.data?.length || 0) >= 1000) {
    throw new AccessError('Application companies could not be verified completely.', 503);
  }
  const companies = [...(companyResult.data || [])] as ApplicationCompanyIdentity[];
  const links = [...input.links];
  const automaticLinks: Array<{ companyGuid: string; financialYear: string; companyId: string; evidence: string }> = [];
  const conflicts = new Set(mappingConflicts.map((conflict) => `${conflict.companyGuid}\u0000${conflict.financialYear}`));
  for (const company of observed.filter((candidate) => candidate.isActive)) {
    const key = `${company.companyGuid}\u0000${company.financialYear}`;
    if (conflicts.has(key) || links.some((link) => link.company_guid === company.companyGuid && link.financial_year === company.financialYear)) continue;
    const target = chooseAutomaticCompanyTarget(company, companies);
    if (target.kind === 'ambiguous') continue;
    let applicationCompany = target.kind === 'existing' ? target.company : null;
    let evidence = target.kind === 'existing' ? target.evidence : 'automatic-active-company-created';
    if (!applicationCompany) {
      const created = await db.from('access_companies').insert({
        organization_id: access.organizationId,
        name: company.companyName,
        erp_identity: target.erpIdentity,
      }).select('id,name,erp_identity').single();
      if (created.error) {
        const existing = await db.from('access_companies').select('id,name,erp_identity')
          .eq('organization_id', access.organizationId).eq('erp_identity', target.erpIdentity).maybeSingle();
        if (existing.error || !existing.data) throw created.error;
        applicationCompany = existing.data as ApplicationCompanyIdentity;
        evidence = 'automatic-exact-erp-identity';
      } else applicationCompany = created.data as ApplicationCompanyIdentity;
      companies.push(applicationCompany);
    }
    const link = await bindConnectionCompanyLink({
      db,
      organizationId: access.organizationId,
      companyId: applicationCompany.id,
      connectionId: connection.id,
      installationId: connection.installation_id,
      companyGuid: company.companyGuid,
      financialYear: company.financialYear,
      evidence,
    });
    links.push(link);
    automaticLinks.push({ companyGuid: company.companyGuid, financialYear: company.financialYear, companyId: applicationCompany.id, evidence });
  }
  if (automaticLinks.length) {
    await db.from('tally_connection_events').insert({
      connection_id: connection.id,
      owner_user_id: connection.owner_user_id,
      event_type: 'company_identity_linked_automatically',
      message: 'Active Tally company identity linked automatically.',
      payload: { links: automaticLinks },
    });
  }
  return { ...input, links, companies, automaticLinks };
}

async function GETHandler(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const resolved = await automaticallyLinkActiveCompanies(await loadManagerConnection(request, id));
    const { observed, links, companies, mappingConflicts, automaticLinks } = resolved;
    const companyNames = new Map(companies.map((company) => [company.id, company.name]));
    const mapped = observed.map((company) => {
      const link = links.find((candidate) => candidate.company_guid === company.companyGuid && candidate.financial_year === company.financialYear);
      return { ...company, linkedCompanyId: link?.company_id || null, linkedCompanyName: link ? companyNames.get(link.company_id) || null : null };
    });
    return jsonWithCors(request, {
      observedCompanies: mapped,
      activeUnlinked: mapped.filter((company) => company.isActive && !company.linkedCompanyId),
      inactiveObserved: mapped.filter((company) => !company.isActive),
      mappingConflicts,
      automaticLinks,
      availableCompanies: companies.map(({ id: companyId, name }) => ({ id: companyId, name })),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    const failure = accessFailureResponse(request, error); if (failure) return failure;
    console.error('Error loading Tally company links:', error);
    return jsonWithCors(request, { error: 'Could not load Tally company links.' }, { status: 500 });
  }
}

async function POSTHandler(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    let companyId = normalizedText(body.companyId);
    const companyGuid = normalizedText(body.companyGuid);
    const financialYear = normalizedText(body.financialYear, 80);
    const createCompany = body.createCompany === true;
    if ((!companyId && !createCompany) || !companyGuid || !financialYear) throw new AccessError('Choose an application company for the observed Tally company and financial year.', 400);
    const { access, db, connection, observed } = await loadManagerConnection(request, id);
    const exactObservation = observed.find((company) => company.companyGuid === companyGuid && company.financialYear === financialYear);
    if (!exactObservation) throw new AccessError('This exact Tally company and financial year is no longer reported by the connector. Refresh and try again.', 409);
    if (createCompany) {
      const erpIdentity = `tally-guid:${companyGuid}:fy:${financialYear}`;
      const existing = await db.from('access_companies').select('id').eq('organization_id', access.organizationId)
        .eq('erp_identity', erpIdentity).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data?.id) companyId = existing.data.id;
      else {
        const created = await db.from('access_companies').insert({
          organization_id: access.organizationId,
          name: exactObservation.companyName,
          erp_identity: erpIdentity,
        }).select('id').single();
        if (created.error) throw created.error;
        companyId = created.data.id;
      }
    } else {
      await requirePermission(request, 'connections.manage', companyId);
      if (!access.companies.some((company) => company.id === companyId)) throw new AccessError('The selected company is not available to you.', 403);
    }
    const historical = await db.from('access_company_links').select('company_id,connection_id')
      .eq('organization_id', access.organizationId).eq('installation_id', connection.installation_id)
      .eq('company_guid', companyGuid).eq('financial_year', financialYear).limit(1000);
    if (historical.error || (historical.data?.length || 0) >= 1000) throw new AccessError('Existing company assignments could not be verified completely.', 503);
    const conflicting = (historical.data || []).find((link) => link.company_id !== companyId);
    if (conflicting) throw new AccessError('This Tally identity was previously linked to another application company. An administrator must review the conflicting mapping.', 409);
    const link = await bindConnectionCompanyLink({
      db,
      organizationId: access.organizationId,
      companyId,
      connectionId: id,
      installationId: connection.installation_id,
      companyGuid,
      financialYear,
      evidence: 'owner-confirmed-agent-observation',
    });
    await db.from('tally_connection_events').insert({
      connection_id: id,
      owner_user_id: access.member.user_id,
      event_type: 'company_identity_linked',
      message: 'Observed Tally company identity linked to an application company.',
      payload: { companyId, companyGuid, financialYear, companyName: exactObservation.companyName },
    });
    return jsonWithCors(request, { link, companyName: exactObservation.companyName });
  } catch (error) {
    const failure = accessFailureResponse(request, error); if (failure) return failure;
    console.error('Error linking Tally company:', error);
    return jsonWithCors(request, { error: 'Could not link the Tally company.' }, { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);
export const POST = withTeamAccess(POSTHandler);
