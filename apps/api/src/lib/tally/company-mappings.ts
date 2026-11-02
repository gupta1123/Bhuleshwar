import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { AccessError } from '@/lib/access/server';

type SupabaseAdmin = ReturnType<typeof createSupabaseAdminClient>;

export type CompanyMappingRow = {
  owner_user_id?: string;
  connection_id: string;
  mapping_type: string;
  source_key: string;
  source_label: string | null;
  target_master_type: string;
  target_master_key: string;
  target_master_name: string;
  status: string;
  updated_at: string | null;
};

const MAPPING_COLUMNS =
  "owner_user_id, connection_id, mapping_type, source_key, source_label, target_master_type, target_master_key, target_master_name, status, updated_at";

// Supplied only after the caller authorizes the case or settings action.
export type CompanyMappingScope = { organizationId: string; companyId: string };

export async function companyMappingConnectionIds(
  supabase: SupabaseAdmin,
  params: { connectionId: string; companyName: string; scope: CompanyMappingScope },
): Promise<string[]> {
  const { scope } = params;
  const company = await supabase.from('access_companies').select('id,name')
    .eq('organization_id', scope.organizationId).eq('id', scope.companyId).maybeSingle();
  if (company.error) throw company.error;
  if (!company.data || company.data.name.trim().toLowerCase() !== params.companyName.trim().toLowerCase()) {
    throw new AccessError('Purchase defaults do not belong to the selected company.', 403);
  }
  const links = await supabase.from('access_company_links').select('connection_id,installation_id')
    .eq('organization_id', scope.organizationId).eq('company_id', scope.companyId).limit(1001);
  if (links.error) throw links.error;
  if ((links.data?.length || 0) >= 1001) throw new AccessError('Company defaults routing is incomplete.', 503);
  const ids = [...new Set((links.data || []).map(link => link.connection_id as string))];
  if (!ids.includes(params.connectionId)) throw new AccessError('Connection is outside the defaults company.', 403);
  if (ids.length > 100) throw new AccessError('Company defaults exceed the supported connection limit.', 503);
  const connections = await supabase.from('tally_connections').select('id,installation_id,revoked_at')
    .eq('organization_id', scope.organizationId).in('id', ids);
  if (connections.error) throw connections.error;
  const current = (connections.data || []).find(connection => connection.id === params.connectionId);
  if (!current || current.revoked_at || !(links.data || []).some(link =>
    link.connection_id === current.id && link.installation_id === current.installation_id)) {
    throw new AccessError('The defaults connection changed. Reconnect and retry.', 409);
  }
  // Historical paired connections retain reviewed defaults; the active target
  // above must still match its current installation. Names never cross FY IDs.
  return (connections.data || []).map(connection => connection.id as string);
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// Saved Tally defaults (purchase ledgers, GST/TDS ledgers, supplier-by-GSTIN, ...) are written
// against the connector connection that saved them. A connector re-pair creates a new
// connection, so reads look across every connection of the same owner for the company and keep
// one row per mapping: the current connection's row first, otherwise the most recently saved.
export async function readCompanyMappings(
  supabase: SupabaseAdmin,
  params: { connectionId: string; companyName: string; ownerUserId?: string | null; scope?: CompanyMappingScope }
): Promise<CompanyMappingRow[]> {
  const companyName = params.companyName.trim();
  if (!params.connectionId || !companyName) return [];

  if (process.env.TEAM_ACCESS_ENFORCEMENT === 'true') {
    if (!params.scope) throw new AccessError('An authorized company scope is required for purchase defaults.', 403);
    const ids = await companyMappingConnectionIds(supabase, { ...params, scope: params.scope });
    const [members, mappings] = await Promise.all([
      supabase.from('access_members').select('user_id').eq('organization_id', params.scope.organizationId).limit(1001),
      supabase.from('tally_mapping_settings').select(MAPPING_COLUMNS).in('connection_id', ids)
        .ilike('company_name', escapeLikePattern(companyName)).limit(5001),
    ]);
    if (members.error) throw members.error;
    if (mappings.error) throw mappings.error;
    if ((members.data?.length || 0) >= 1001 || (mappings.data?.length || 0) >= 5001) {
      throw new AccessError('Company defaults could not be completely loaded.', 503);
    }
    const owners = new Set((members.data || []).map(member => member.user_id));
    const rows = ((mappings.data || []) as CompanyMappingRow[]).filter(row => owners.has(row.owner_user_id))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) ||
        a.connection_id.localeCompare(b.connection_id));
    const seen = new Set<string>();
    return rows.filter(row => {
      const key = `${row.mapping_type}\u0000${row.source_key.trim().toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return row.status === 'active';
    });
  }

  let ownerUserId = params.ownerUserId ?? null;
  if (!ownerUserId) {
    const { data, error } = await supabase
      .from("tally_connections")
      .select("owner_user_id")
      .eq("id", params.connectionId)
      .maybeSingle();
    if (error) throw error;
    ownerUserId = (data?.owner_user_id as string | undefined) ?? null;
  }
  if (!ownerUserId) return [];

  const { data, error } = await supabase
    .from("tally_mapping_settings")
    .select(MAPPING_COLUMNS)
    .eq("owner_user_id", ownerUserId)
    .ilike("company_name", escapeLikePattern(companyName))
    .eq("status", "active");
  if (error) throw error;

  const rows = ((data ?? []) as CompanyMappingRow[]).sort((left, right) => {
    const leftCurrent = left.connection_id === params.connectionId ? 1 : 0;
    const rightCurrent = right.connection_id === params.connectionId ? 1 : 0;
    if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
    return String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? ""));
  });

  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.mapping_type}\u0000${row.source_key.trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
