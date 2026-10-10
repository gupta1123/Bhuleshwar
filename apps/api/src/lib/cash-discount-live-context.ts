// Everything a Cash Discount / Payment Follow-ups analysis needs from the
// database, with the same access checks for both uses: the analyse route
// (connector sends its scan here) and the analysis-context route (the
// gateway hands this to a connector that analyses the scan itself).
import { readCompleteHistory } from "@/lib/collections-history";
import { requireDataset } from "@/lib/access/dataset";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export function normalizeCompanyName(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export type LiveAnalysisContext =
  | { ok: true; proposalRows: unknown[]; connectionStatus: string | null; lastHeartbeatAt: string | null; databaseMs: number }
  | { ok: false; status: number; error: string };

export async function loadLiveAnalysisContext(request: Request, userId: string, params: {
  connectionId: string;
  companyName: string;
  financialYear: string | null;
  companyGuid?: unknown;
  followUps: boolean;
}): Promise<LiveAnalysisContext> {
  const { connectionId, companyName, financialYear, followUps } = params;
  const supabase = createSupabaseAdminClient();
  const team = process.env.TEAM_ACCESS_ENFORCEMENT === 'true'
    ? await requireDataset(request, connectionId, { companyName, financialYear, companyGuid: params.companyGuid as string | undefined }, followUps ? 'followups.prepare' : 'discounts.prepare')
    : null;
  let proposals = supabase.from('debit_note_proposals').select('*').eq('company_name', companyName).eq('status', 'created_in_tally')
    .order('created_at', { ascending: false }).order('id', { ascending: false });
  proposals = team ? proposals.eq('access_organization_id', team.access.organizationId).eq('access_company_id', team.link.company_id) : proposals.eq('owner_user_id', userId);
  const databaseStartedAt = performance.now();
  const [{ data: connection, error: connectionError }, { data: proposalRows, error: proposalError }] = await Promise.all([
    team ? Promise.resolve({ data: team.connection, error: null }) : supabase
      .from("tally_connections")
      .select("id, owner_user_id, status, last_company_name, last_heartbeat_at, last_tally_reachable, last_company_loaded")
      .eq("id", connectionId)
      .eq("owner_user_id", userId)
      .is("revoked_at", null)
      .maybeSingle(),
    // Follow-up access must not expose debit-note history.
    followUps ? Promise.resolve({ data: [], error: null }) : readCompleteHistory((from, to) => proposals.range(from, to)).then(data => ({ data, error: null })),
  ]);
  const databaseMs = performance.now() - databaseStartedAt;
  if (connectionError) throw connectionError;
  if (proposalError) throw proposalError;
  if (!connection) return { ok: false, status: 404, error: "Tally connection not found." };
  if (
    connection.last_tally_reachable !== true ||
    connection.last_company_loaded !== true ||
    normalizeCompanyName(connection.last_company_name) !== normalizeCompanyName(companyName)
  ) {
    return {
      ok: false,
      status: 409,
      error: `Tally is currently open to ${connection.last_company_name || "another company"}. Refresh the connection before calculating Cash Discounts.`,
    };
  }
  return { ok: true, proposalRows: proposalRows ?? [], connectionStatus: connection.status ?? null, lastHeartbeatAt: connection.last_heartbeat_at ?? null, databaseMs };
}
