import { withTeamAccess } from '@/lib/access/route-boundary';
import { authorizeLiveConnection } from '@/lib/access/live-authority';
import { AccessError } from '@/lib/access/server';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashSecret, TALLY_CONNECTION_SELECT, type TallyConnectionRow } from "@/lib/tally/connections";
import {
  DEFAULT_CASH_DISCOUNT_CUSTOMER_SCOPE,
  getCashDiscountCustomerScopeOrDefault,
  getCashDiscountCustomerScopesByCompany,
} from "@/lib/cash-discount-customer-scope";

function bearerToken(request: Request) {
  return request.headers.get("x-bridge-token") ??
    request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ??
    "";
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function POSTHandler(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const role = String(body.role ?? "");
    const connectionId = String(body.connectionId ?? "").trim();
    const companyName = String(body.companyName ?? "").trim();
    if (!connectionId || !["browser", "connector"].includes(role)) {
      return jsonWithCors(request, { error: "A valid live-session role and connection are required." }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    if (role === "browser") {
      const user = await requireRequestUser(request);
      if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
      // Company discovery feeds APIs that always require an exact, reviewed
      // dataset identity. Resolve it even during the legacy owner rollout so
      // the browser never has to turn a company name into an authorization.
      if(process.env.TEAM_ACCESS_ENFORCEMENT==='true' || Boolean(body.operation)) {
        const authority=await authorizeLiveConnection(request,body);
        return jsonWithCors(request,{authenticated:true,teamAccess:true,connectionId,...authority},
          {headers:{'Cache-Control':'private, no-store'}});
      }
      const [connectionResult, customerScopeResult] = await Promise.all([
        supabase
          .from("tally_connections")
          .select("id, owner_user_id, revoked_at")
          .eq("id", connectionId)
          .eq("owner_user_id", user.id)
          .is("revoked_at", null)
          .maybeSingle(),
        companyName
          ? getCashDiscountCustomerScopeOrDefault({
              ownerUserId: user.id,
              connectionId,
              companyName,
            })
          : getCashDiscountCustomerScopesByCompany({
              ownerUserId: user.id,
              connectionId,
            }),
      ]);
      const { data, error } = connectionResult;
      if (error) throw error;
      if (!data) return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
      return jsonWithCors(request, {
        authenticated: true,
        ownerUserId: user.id,
        connectionId,
        customerScope: companyName ? customerScopeResult : null,
        customerScopes: companyName ? null : customerScopeResult,
        defaultCustomerScope: DEFAULT_CASH_DISCOUNT_CUSTOMER_SCOPE,
      });
    }

    const token = bearerToken(request);
    if (!token) return jsonWithCors(request, { error: "Bridge token is required." }, { status: 401 });
    const { data, error } = await supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .eq("id", connectionId)
      .maybeSingle();
    if (error) throw error;
    const connection = data as unknown as TallyConnectionRow | null;
    if (!connection || connection.revoked_at) {
      return jsonWithCors(request, { error: "This connector session is no longer active." }, { status: 409 });
    }
    if (!connection.bridge_token_hash || hashSecret(token) !== connection.bridge_token_hash) {
      return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
    }

    return jsonWithCors(request, {
      authenticated: true,
      ownerUserId: connection.owner_user_id,
      connectionId: connection.id,
      installationId:connection.installation_id,
      sessionGeneration:connection.session_generation,
    });
  } catch (error) {
    if(error instanceof AccessError)return jsonWithCors(request,{error:error.message},{status:error.status});
    console.error("Error in POST /api/collections/live/session:", error);
    return jsonWithCors(request, { error: "Could not authenticate the live Cash Discount session." }, { status: 500 });
  }
}

export const POST = withTeamAccess(POSTHandler,{bridgeSession:true});
