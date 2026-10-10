import { withTeamAccess } from '@/lib/access/route-boundary';
import {requireDataset} from '@/lib/access/dataset';
import {accessFailureResponse} from '@/lib/access/failures';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  analyseLiveCashDiscountSnapshot,
  liveCashDiscountLedgerRow,
  type LiveCashDiscountLedger,
} from "@/lib/cash-discount-live-analysis";
import { toText } from "@/lib/collections";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function POSTHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const connectionId = toText(body.connectionId, 80);
    const companyName = toText(body.companyName, 240);
    const scan = body.scan && typeof body.scan === "object" ? body.scan as Record<string, unknown> : {};
    const openBillsResult = scan.openBillsResult && typeof scan.openBillsResult === "object"
      ? scan.openBillsResult as Record<string, unknown>
      : null;
    if (!connectionId || !companyName || !openBillsResult) {
      return jsonWithCors(request, { error: "A live Tally company scan is required." }, { status: 400 });
    }
    const ledgers = Array.isArray(scan.ledgers)
      ? (scan.ledgers as LiveCashDiscountLedger[]).map(liveCashDiscountLedgerRow).filter((row): row is NonNullable<typeof row> => Boolean(row))
      : [];
    if(process.env.TEAM_ACCESS_ENFORCEMENT==='true')await requireDataset(request,connectionId,{companyName,companyGuid:body.companyGuid,financialYear:body.financialYear||scan.financialYear},'discounts.prepare');
    return jsonWithCors(request, analyseLiveCashDiscountSnapshot({
      connectionId,
      companyName,
      financialYear: toText(scan.financialYear, 20) || null,
      openBillsResult,
      ledgers,
      preview: true,
    }));
  } catch (error) {
    const failure=accessFailureResponse(request,error);if(failure)return failure;
    console.error("Error in POST /api/collections/live/analyse-preview:", error);
    return jsonWithCors(request, {
      error: error instanceof Error ? error.message : "Could not calculate the live Cash Discount preview.",
    }, { status: 500 });
  }
}

export const POST = withTeamAccess(POSTHandler);
