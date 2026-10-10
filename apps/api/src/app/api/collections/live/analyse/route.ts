import { withTeamAccess } from '@/lib/access/route-boundary';
import {accessFailureResponse} from '@/lib/access/failures';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { buildLiveCashDiscountDashboard } from "@/lib/cash-discount-live-dashboard";
import { loadLiveAnalysisContext } from "@/lib/cash-discount-live-context";
import { toText } from "@/lib/collections";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

// Analyses a connector scan that arrived with its open bills. Connectors from
// 1.2.24 can analyse the scan themselves (with /api/collections/live/analysis-context)
// when the gateway enables CASH_DISCOUNT_CONNECTOR_ANALYSIS; otherwise every
// scan comes through here.
async function POSTHandler(request: Request) {
  const diagnosticStartedAt = performance.now();
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const connectionId = toText(body.connectionId, 80);
    const companyName = toText(body.companyName, 240);
    const scan = body.scan && typeof body.scan === "object" ? body.scan as Record<string, unknown> : {};
    const benchmarkDiagnostics = scan.benchmarkDiagnostics && typeof scan.benchmarkDiagnostics === "object"
      ? scan.benchmarkDiagnostics
      : null;
    const financialYear = toText(scan.financialYear, 20) || null;
    if (!connectionId || !companyName || !scan.openBillsResult || typeof scan.openBillsResult !== "object") {
      return jsonWithCors(request, { error: "A live Tally company scan is required." }, { status: 400 });
    }

    const followUps = new URL(request.url).pathname === '/api/collections/follow-ups/analyse';
    const context = await loadLiveAnalysisContext(request, user.id, {
      connectionId, companyName, financialYear: body.financialYear || financialYear, companyGuid: body.companyGuid, followUps,
    });
    if (!context.ok) return jsonWithCors(request, { error: context.error }, { status: context.status });

    const analysisStartedAt = performance.now();
    const dashboard = buildLiveCashDiscountDashboard({
      connectionId,
      companyName,
      financialYear,
      scan,
      proposalRows: context.proposalRows,
      connectionStatus: context.connectionStatus,
      lastHeartbeatAt: context.lastHeartbeatAt,
      followUps,
    });
    const analysisMs = performance.now() - analysisStartedAt;
    if (followUps) return jsonWithCors(request, dashboard);
    return jsonWithCors(request, {
      ...dashboard,
      ...(benchmarkDiagnostics ? {
        benchmarkDiagnostics: {
          connector: benchmarkDiagnostics,
          api: {
            databaseMs: Number(context.databaseMs.toFixed(2)),
            analysisMs: Number(analysisMs.toFixed(2)),
            totalMs: Number((performance.now() - diagnosticStartedAt).toFixed(2)),
          },
        },
      } : {}),
    });
  } catch (error) {
    const failure=accessFailureResponse(request,error);if(failure)return failure;
    console.error("Error in POST /api/collections/live/analyse:", error);
    return jsonWithCors(request, {
      error: error instanceof Error ? error.message : "Could not analyse the live Tally data.",
    }, { status: 500 });
  }
}

export const POST = withTeamAccess(POSTHandler);
