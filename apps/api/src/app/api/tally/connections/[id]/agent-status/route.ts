import { withTeamAccess } from '@/lib/access/route-boundary';
import { permittedConnections } from '@/lib/access/connection-scope';
import { accessFailureResponse } from '@/lib/access/failures';
import { requireAccessContext } from '@/lib/access/server';
import { canAccess } from '@autodealer/shared/lib/access';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type AgentCompany = { companyName: string; guid: string; financialYear: string; isActive: boolean; accessCompanyId?: string };

export function OPTIONS(request: Request) { return optionsWithCors(request); }

async function GETHandler(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    const { id } = await context.params;
    const supabase = createSupabaseAdminClient();
    if (process.env.TEAM_ACCESS_ENFORCEMENT === 'true') {
      const accessContext = await requireAccessContext(request);
      if (canAccess(accessContext, 'connections.manage') && accessContext.member.all_companies) {
        const connectionResult = await supabase.from('tally_connections')
          .select('id,organization_id,owner_user_id,installation_id,session_generation,bridge_machine_name,last_company_name,last_companies_snapshot,last_heartbeat_at,agent_last_seen_at,agent_version,agent_protocol_version,agent_capabilities,agent_status,tdl_version,local_schema_version')
          .eq('id', id).eq('organization_id', accessContext.organizationId)
          .eq('owner_user_id', accessContext.member.user_id).is('revoked_at', null).maybeSingle();
        if (connectionResult.error) throw connectionResult.error;
        const connection = connectionResult.data;
        if (!connection) return jsonWithCors(request, {error: 'Tally connection not found.'}, {status: 404});
        const [datasetResult, linkResult] = await Promise.all([
          supabase.from('tally_agent_datasets')
            .select('company_guid,company_name,financial_year,cache_health,cache_size_bytes,last_synced_at,last_reconciled_at,quarantined_at,quarantine_reason,tdl_version,local_schema_version')
            .eq('organization_id', accessContext.organizationId).eq('connection_id', id)
            .eq('installation_id', connection.installation_id).limit(1000),
          supabase.from('access_company_links')
            .select('company_id,company_guid,financial_year').eq('organization_id', accessContext.organizationId)
            .eq('connection_id', id).eq('installation_id', connection.installation_id).limit(1000),
        ]);
        if (datasetResult.error || linkResult.error || (datasetResult.data?.length || 0) >= 1000 || (linkResult.data?.length || 0) >= 1000) {
          return jsonWithCors(request, {error: 'Scoped agent status is unavailable.'}, {status: 503});
        }
        const links = linkResult.data || [];
        const observed = new Map<string, AgentCompany>();
        const addCompany = (value: Record<string, unknown>) => {
          const guid = String(value.company_guid ?? value.guid ?? '').trim();
          const financialYear = String(value.financial_year ?? value.financialYear ?? '').trim();
          const companyName = String(value.company_name ?? value.companyName ?? value.name ?? '').trim();
          if (!guid || !financialYear || !companyName) return;
          const link = links.find((candidate) => candidate.company_guid === guid && candidate.financial_year === financialYear);
          observed.set(`${guid}\u0000${financialYear}`, {
            companyName, guid, financialYear, accessCompanyId: link?.company_id,
            isActive: connection.last_company_name === companyName,
          });
        };
        for (const dataset of datasetResult.data || []) addCompany(dataset as Record<string, unknown>);
        for (const company of Array.isArray(connection.last_companies_snapshot) ? connection.last_companies_snapshot : []) {
          if (company && typeof company === 'object') addCompany(company as Record<string, unknown>);
        }
        return jsonWithCors(request, {
          connection: {id, organizationId: accessContext.organizationId, installationId: connection.installation_id,
            sessionGeneration: connection.session_generation, machineName: connection.bridge_machine_name,
            lastHeartbeatAt: connection.last_heartbeat_at, companies: [...observed.values()]},
          agent: {version: connection.agent_version, protocolVersion: connection.agent_protocol_version,
            capabilities: connection.agent_capabilities || [], status: connection.agent_status || {},
            lastSeenAt: connection.agent_last_seen_at, tdlVersion: connection.tdl_version,
            localSchemaVersion: connection.local_schema_version},
          datasets: datasetResult.data || [],
        }, {headers: {'Cache-Control': 'private, no-store'}});
      }
      const {access, links, rows} = await permittedConnections(request, id);
      const connection = rows.find(row => row.id === id);
      if (!connection) return jsonWithCors(request, {error: 'Tally connection not found.'}, {status: 404});
      const {data, error} = await supabase.from('tally_agent_datasets')
        .select('company_guid,company_name,financial_year,cache_health,cache_size_bytes,last_synced_at,last_reconciled_at,quarantined_at,tdl_version,local_schema_version')
        .eq('organization_id', access.organizationId).eq('connection_id', id)
        .eq('installation_id', connection.installation_id).limit(1000);
      if (error || (data?.length || 0) >= 1000) return jsonWithCors(request, {error: 'Scoped agent status is unavailable.'}, {status: 503});
      return jsonWithCors(request, {
        connection: {id, organizationId: access.organizationId, installationId: connection.installation_id,
          sessionGeneration: connection.session_generation, machineName: connection.bridge_machine_name,
          lastHeartbeatAt: connection.last_heartbeat_at,
          companies: links.map(link => ({companyName: link.company_name, guid: link.company_guid,
            financialYear: link.financial_year, accessCompanyId: link.company_id,
            isActive: connection.last_company_loaded && connection.last_company_name === link.company_name}))},
        agent: {version: connection.agent_version, protocolVersion: connection.agent_protocol_version,
          lastSeenAt: connection.agent_last_seen_at, tdlVersion: connection.tdl_version,
          localSchemaVersion: connection.local_schema_version, status: {}},
        datasets: (data || []).filter(row => links.some(link => link.company_guid === row.company_guid && link.financial_year === row.financial_year)).map(row => ({
          ...row,
          cache_health: {
            workflowRevisions: row.cache_health && typeof row.cache_health === 'object'
              ? (row.cache_health as Record<string, unknown>).workflowRevisions || {}
              : {},
          },
        })),
      }, {headers: {'Cache-Control': 'private, no-store'}});
    }
    const { data: connection, error } = await supabase.from("tally_connections")
      .select("id,organization_id,installation_id,session_generation,bridge_machine_name,last_company_name,last_companies_snapshot,last_heartbeat_at,agent_last_seen_at,agent_version,agent_protocol_version,agent_capabilities,agent_status,tdl_version,local_schema_version")
      .eq("id", id).eq("owner_user_id", user.id).is("revoked_at", null).maybeSingle();
    if (error) throw error;
    if (!connection) return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
    const { data: datasets, error: datasetError } = await supabase.from("tally_agent_datasets")
      .select("company_guid,company_name,financial_year,cache_health,cache_size_bytes,last_synced_at,last_reconciled_at,quarantined_at,quarantine_reason,tdl_version,local_schema_version")
      .eq("connection_id", id).eq("owner_user_id", user.id).order("updated_at", { ascending: false });
    if (datasetError) throw datasetError;
    return jsonWithCors(request, {
      connection: {
        id: connection.id, organizationId: connection.organization_id,
        installationId: connection.installation_id, sessionGeneration: connection.session_generation,
        machineName: connection.bridge_machine_name, companyName: connection.last_company_name,
        companies: connection.last_companies_snapshot || [], lastHeartbeatAt: connection.last_heartbeat_at,
      },
      agent: {
        version: connection.agent_version, protocolVersion: connection.agent_protocol_version,
        capabilities: connection.agent_capabilities || [], status: connection.agent_status || {},
        lastSeenAt: connection.agent_last_seen_at, tdlVersion: connection.tdl_version,
        localSchemaVersion: connection.local_schema_version,
      },
      datasets: datasets || [],
    });
  } catch (error) {
    const failure = accessFailureResponse(request, error); if (failure) return failure;
    console.error("Error in GET Local Agent status:", error);
    return jsonWithCors(request, { error: "Could not load Local Agent status." }, { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);
