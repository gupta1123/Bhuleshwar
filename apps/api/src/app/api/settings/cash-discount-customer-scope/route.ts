import { withTeamAccess } from '@/lib/access/route-boundary';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  getCashDiscountCustomerScope,
  isCashDiscountCustomerScopeSchemaMissing,
  normalizeCashDiscountCustomerScope,
  saveCashDiscountCustomerScope,
} from "@/lib/cash-discount-customer-scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const MIGRATION_FILE = "supabase/migrations/202608160001_cash_discount_customer_scope_settings.sql";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

function schemaMissing(request: Request) {
  return jsonWithCors(request, {
    error: `Cash Discount customer scope is not installed. Run ${MIGRATION_FILE}.`,
    migrationRequired: true,
    migrationFile: MIGRATION_FILE,
  }, { status: 409 });
}

async function ownedConnection(ownerUserId: string, connectionId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("tally_connections")
    .select("id")
    .eq("id", connectionId)
    .eq("owner_user_id", ownerUserId)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

function requestContext(request: Request, body?: Record<string, unknown>) {
  const url = new URL(request.url);
  return {
    connectionId: String(body?.connectionId ?? url.searchParams.get("connectionId") ?? "").trim(),
    companyName: String(body?.companyName ?? url.searchParams.get("companyName") ?? "").trim(),
  };
}

async function GETHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    const context = requestContext(request);
    if (!context.connectionId || !context.companyName) {
      return jsonWithCors(request, { error: "Connection and company are required." }, { status: 400 });
    }
    if (!await ownedConnection(user.id, context.connectionId)) {
      return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
    }
    const settings = await getCashDiscountCustomerScope({ ownerUserId: user.id, ...context });
    return jsonWithCors(request, { settings });
  } catch (error) {
    if (isCashDiscountCustomerScopeSchemaMissing(error)) return schemaMissing(request);
    console.error("Error in GET /api/settings/cash-discount-customer-scope:", error);
    return jsonWithCors(request, { error: "Could not load Cash Discount customer scope." }, { status: 500 });
  }
}

async function PUTHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const context = requestContext(request, body);
    if (!context.connectionId || !context.companyName) {
      return jsonWithCors(request, { error: "Connection and company are required." }, { status: 400 });
    }
    if (!await ownedConnection(user.id, context.connectionId)) {
      return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
    }
    const settings = await saveCashDiscountCustomerScope({
      ownerUserId: user.id,
      ...context,
      settings: normalizeCashDiscountCustomerScope(body.settings),
    });
    return jsonWithCors(request, { success: true, settings });
  } catch (error) {
    if (isCashDiscountCustomerScopeSchemaMissing(error)) return schemaMissing(request);
    console.error("Error in PUT /api/settings/cash-discount-customer-scope:", error);
    return jsonWithCors(request, { error: "Could not save Cash Discount customer scope." }, { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);
export const PUT = withTeamAccess(PUTHandler);
