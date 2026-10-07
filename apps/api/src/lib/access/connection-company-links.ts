import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export type CompanyLinkIdentity = {
  organization_id: string;
  company_id: string;
  connection_id: string;
  installation_id: string;
  company_guid: string;
  financial_year: string;
  verified_at: string;
  evidence: string;
};

export type ObservedCompanyIdentity = {
  companyGuid: string;
  companyName: string;
  financialYear: string;
  isActive: boolean;
};

export type ApplicationCompanyIdentity = { id: string; name: string; erp_identity: string };

type StableCompanyLink = Omit<CompanyLinkIdentity, 'connection_id'> & {
  source_connection_id: string | null;
  last_seen_at: string;
};

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedCompanyName(value: unknown) {
  return text(value).toLocaleLowerCase('en-IN').replace(/\s+/g, ' ');
}

export function chooseAutomaticCompanyTarget(company: ObservedCompanyIdentity, candidates: ApplicationCompanyIdentity[]) {
  const erpIdentity = `tally-guid:${company.companyGuid}:fy:${company.financialYear}`;
  const identityMatches = candidates.filter((candidate) => candidate.erp_identity === erpIdentity);
  if (identityMatches.length === 1) return { kind: 'existing' as const, company: identityMatches[0], evidence: 'automatic-exact-erp-identity' };
  if (identityMatches.length > 1) return { kind: 'ambiguous' as const };
  const wantedName = normalizedCompanyName(company.companyName);
  const nameMatches = candidates.filter((candidate) => normalizedCompanyName(candidate.name) === wantedName);
  if (nameMatches.length === 1) return { kind: 'existing' as const, company: nameMatches[0], evidence: 'automatic-unique-company-name' };
  if (nameMatches.length > 1) return { kind: 'ambiguous' as const };
  return { kind: 'create' as const, erpIdentity };
}

function identityKey(link: Pick<CompanyLinkIdentity, 'company_guid' | 'financial_year'>) {
  return `${text(link.company_guid)}\u0000${text(link.financial_year)}`;
}

export function selectRestorableCompanyLinks(
  historical: CompanyLinkIdentity[],
  stable: StableCompanyLink[],
  input: { organizationId: string; installationId: string; connectionId: string; now: string },
) {
  const candidates = [...historical, ...stable.map((link) => ({
    ...link,
    connection_id: link.source_connection_id || input.connectionId,
  }))].filter((link) =>
    link.organization_id === input.organizationId &&
    link.installation_id === input.installationId &&
    text(link.company_guid) && text(link.financial_year) && text(link.company_id)
  );
  const byIdentity = new Map<string, CompanyLinkIdentity[]>();
  for (const link of candidates) {
    const key = identityKey(link);
    byIdentity.set(key, [...(byIdentity.get(key) || []), link]);
  }
  const conflicts: Array<{ companyGuid: string; financialYear: string; companyIds: string[] }> = [];
  const links: CompanyLinkIdentity[] = [];
  for (const entries of byIdentity.values()) {
    const companyIds = [...new Set(entries.map((entry) => entry.company_id))];
    if (companyIds.length !== 1) {
      conflicts.push({
        companyGuid: entries[0].company_guid,
        financialYear: entries[0].financial_year,
        companyIds,
      });
      continue;
    }
    const latest = [...entries].sort((left, right) =>
      Date.parse(right.verified_at || '') - Date.parse(left.verified_at || '')
    )[0];
    links.push({
      organization_id: input.organizationId,
      company_id: companyIds[0],
      connection_id: input.connectionId,
      installation_id: input.installationId,
      company_guid: text(latest.company_guid),
      financial_year: text(latest.financial_year),
      verified_at: latest.verified_at || input.now,
      evidence: 'restored-from-verified-installation-identity',
    });
  }
  return { links, conflicts };
}

function stableTableUnavailable(error: unknown) {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = [record.code, record.message, record.details, record.hint]
    .filter(Boolean).join(' ');
  return /42P01|PGRST20[045]|access_company_installation_links|schema cache|does not exist/i.test(message);
}

async function readStableLinks(
  db: AdminClient,
  organizationId: string,
  installationId: string,
): Promise<StableCompanyLink[]> {
  const result = await db.from('access_company_installation_links')
    .select('organization_id,company_id,installation_id,company_guid,financial_year,verified_at,evidence,source_connection_id,last_seen_at')
    .eq('organization_id', organizationId)
    .eq('installation_id', installationId)
    .limit(1000);
  if (result.error) {
    if (stableTableUnavailable(result.error)) return [];
    throw result.error;
  }
  if ((result.data?.length || 0) >= 1000) throw new Error('Stable company mappings could not be read completely.');
  return (result.data || []) as StableCompanyLink[];
}

async function writeStableLinks(db: AdminClient, links: CompanyLinkIdentity[], now: string) {
  if (!links.length) return;
  const rows = links.map((link) => ({
    organization_id: link.organization_id,
    company_id: link.company_id,
    installation_id: link.installation_id,
    company_guid: link.company_guid,
    financial_year: link.financial_year,
    verified_at: link.verified_at,
    last_seen_at: now,
    evidence: link.evidence,
    source_connection_id: link.connection_id,
  }));
  const result = await db.from('access_company_installation_links').upsert(rows, {
    onConflict: 'organization_id,installation_id,company_guid,financial_year',
    ignoreDuplicates: true,
  });
  if (result.error && !stableTableUnavailable(result.error)) throw result.error;
}

export async function restoreConnectionCompanyLinks(input: {
  organizationId: string;
  installationId: string;
  connectionId: string;
  now?: string;
  db?: AdminClient;
}) {
  const db = input.db || createSupabaseAdminClient();
  const now = input.now || new Date().toISOString();
  const historicalResult = await db.from('access_company_links')
    .select('organization_id,company_id,connection_id,installation_id,company_guid,financial_year,verified_at,evidence')
    .eq('organization_id', input.organizationId)
    .eq('installation_id', input.installationId)
    .limit(1000);
  if (historicalResult.error) throw historicalResult.error;
  if ((historicalResult.data?.length || 0) >= 1000) throw new Error('Historical company mappings could not be read completely.');
  const stable = await readStableLinks(db, input.organizationId, input.installationId);
  const selected = selectRestorableCompanyLinks(
    (historicalResult.data || []) as CompanyLinkIdentity[], stable,
    { ...input, now },
  );
  if (selected.links.length) {
    const restored = await db.from('access_company_links').upsert(selected.links, {
      onConflict: 'organization_id,connection_id,installation_id,company_guid,financial_year',
    });
    if (restored.error) throw restored.error;
    await writeStableLinks(db, selected.links, now);
  }
  return { restored: selected.links.length, conflicts: selected.conflicts };
}

export async function bindConnectionCompanyLink(input: {
  organizationId: string;
  companyId: string;
  connectionId: string;
  installationId: string;
  companyGuid: string;
  financialYear: string;
  evidence: string;
  now?: string;
  db?: AdminClient;
}) {
  const db = input.db || createSupabaseAdminClient();
  const now = input.now || new Date().toISOString();
  const link: CompanyLinkIdentity = {
    organization_id: input.organizationId,
    company_id: input.companyId,
    connection_id: input.connectionId,
    installation_id: input.installationId,
    company_guid: text(input.companyGuid),
    financial_year: text(input.financialYear),
    verified_at: now,
    evidence: input.evidence,
  };
  const current = await db.from('access_company_links').upsert(link, {
    onConflict: 'organization_id,connection_id,installation_id,company_guid,financial_year',
  });
  if (current.error) throw current.error;
  await writeStableLinks(db, [link], now);
  return link;
}

export async function automaticallyLinkObservedActiveCompanies(input: {
  organizationId: string;
  connectionId: string;
  installationId: string;
  companies: Array<Record<string, unknown>>;
  now?: string;
  db?: AdminClient;
}) {
  const db = input.db || createSupabaseAdminClient();
  const candidates = input.companies.flatMap((row) => {
    const companyGuid = text(row.companyGuid ?? row.company_guid ?? row.guid);
    const companyName = text(row.companyName ?? row.company_name ?? row.name);
    const financialYear = text(row.financialYear ?? row.financial_year);
    return row.isActive === true && companyGuid && companyName && financialYear
      ? [{ companyGuid, companyName, financialYear, isActive: true }]
      : [];
  });
  if (!candidates.length) return { linked: 0, skipped: 0 };

  const [companyResult, linkResult] = await Promise.all([
    db.from('access_companies').select('id,name,erp_identity')
      .eq('organization_id', input.organizationId).limit(1000),
    db.from('access_company_links').select('company_id,company_guid,financial_year')
      .eq('organization_id', input.organizationId).eq('connection_id', input.connectionId)
      .eq('installation_id', input.installationId).limit(1000),
  ]);
  if (companyResult.error) throw companyResult.error;
  if (linkResult.error) throw linkResult.error;
  if ((companyResult.data?.length || 0) >= 1000 || (linkResult.data?.length || 0) >= 1000) {
    throw new Error('Automatic company linking could not verify all candidates.');
  }

  const applicationCompanies = [...(companyResult.data || [])] as ApplicationCompanyIdentity[];
  const links = [...(linkResult.data || [])];
  let linked = 0;
  let skipped = 0;
  for (const company of candidates) {
    if (links.some((link) => link.company_guid === company.companyGuid && link.financial_year === company.financialYear)) continue;
    const target = chooseAutomaticCompanyTarget(company, applicationCompanies);
    if (target.kind === 'ambiguous') { skipped += 1; continue; }
    let applicationCompany = target.kind === 'existing' ? target.company : null;
    let evidence = target.kind === 'existing' ? target.evidence : 'automatic-active-company-created';
    if (!applicationCompany) {
      const created = await db.from('access_companies').insert({
        organization_id: input.organizationId,
        name: company.companyName,
        erp_identity: target.erpIdentity,
      }).select('id,name,erp_identity').single();
      if (created.error) {
        const existing = await db.from('access_companies').select('id,name,erp_identity')
          .eq('organization_id', input.organizationId).eq('erp_identity', target.erpIdentity).maybeSingle();
        if (existing.error || !existing.data) throw created.error;
        applicationCompany = existing.data as ApplicationCompanyIdentity;
        evidence = 'automatic-exact-erp-identity';
      } else applicationCompany = created.data as ApplicationCompanyIdentity;
      applicationCompanies.push(applicationCompany);
    }
    const link = await bindConnectionCompanyLink({
      db,
      organizationId: input.organizationId,
      companyId: applicationCompany.id,
      connectionId: input.connectionId,
      installationId: input.installationId,
      companyGuid: company.companyGuid,
      financialYear: company.financialYear,
      evidence,
      now: input.now,
    });
    links.push(link);
    linked += 1;
  }
  return { linked, skipped };
}
