import { withTeamAccess } from '@/lib/access/route-boundary';
import {requireMasterDataset} from '@/lib/access/master-store';
import {enqueueTeamDiscount} from '@/lib/access/discount-writes';
import {accessFailureResponse} from '@/lib/access/failures';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { analyseCashDiscountNarration } from "@/lib/cash-discount-narration";
import { toNullableText, toNumber, toText } from "@/lib/collections";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { serializeTallyBridgeCommand, type TallyBridgeCommandRow } from "@/lib/tally/commands";
import { businessDateText } from "@/lib/business-date";

function isLiveConnection(row: { status?: string | null; last_tally_reachable?: boolean | null; last_company_loaded?: boolean | null }) {
  return row.status === "company_loaded" || (row.last_tally_reachable === true && row.last_company_loaded === true);
}

function normalizeCompanyName(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

type OpenBillRow = {
  kind?: string | null;
  ledgerName?: string | null;
  referenceName?: string | null;
  voucherNumber?: string | null;
  invoiceDate?: string | null;
  originalAmount?: number | string | null;
  pendingAmount?: number | string | null;
  narration?: string | null;
  receiptDate?: string | null;
  matchedReceiptAmount?: number | string | null;
  sourceSalesLedgerName?: string | null;
};

type TallyCommandSnapshot = {
  id: string;
  status: string;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  completed_at: string | null;
  created_at: string;
};

function commandCompanyName(command: TallyCommandSnapshot) {
  return toNullableText(command.payload?.companyName, 240);
}

function commandScanId(command: TallyCommandSnapshot) {
  return toNullableText(command.payload?.scanId, 120);
}

function readTallyOpenBills(commandResult: Record<string, unknown> | null | undefined) {
  const result = commandResult?.result && typeof commandResult.result === "object"
    ? (commandResult.result as Record<string, unknown>)
    : commandResult;
  const byLedger = result?.byLedger && typeof result.byLedger === "object"
    ? (result.byLedger as Record<string, { ledgerName?: string | null; openBills?: OpenBillRow[] }>)
    : {};

  return Object.entries(byLedger).flatMap(([ledgerName, bucket]) =>
    (Array.isArray(bucket?.openBills) ? bucket.openBills : []).map((bill) => ({
      ledgerName: toText(bill.ledgerName ?? bucket?.ledgerName ?? ledgerName, 500),
      bill,
    }))
  );
}

function sameInvoice(
  row: { ledgerName: string; bill: OpenBillRow },
  partyLedgerName: string,
  linkedInvoiceNumber: string
) {
  const rowReference = toText(row.bill.referenceName ?? row.bill.voucherNumber, 240);
  return (
    normalizeCompanyName(row.ledgerName) === normalizeCompanyName(partyLedgerName) &&
    normalizeCompanyName(rowReference) === normalizeCompanyName(linkedInvoiceNumber)
  );
}

function commandMatchesInvoice(
  command: TallyCommandSnapshot,
  companyName: string,
  partyLedgerName: string,
  linkedInvoiceNumber: string
) {
  return (
    normalizeCompanyName(toNullableText(command.payload?.companyName, 240)) === normalizeCompanyName(companyName) &&
    normalizeCompanyName(toNullableText(command.payload?.partyLedgerName, 500)) === normalizeCompanyName(partyLedgerName) &&
    normalizeCompanyName(toNullableText(command.payload?.linkedInvoiceNumber, 120)) === normalizeCompanyName(linkedInvoiceNumber)
  );
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function POSTHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const proposal = body.proposal && typeof body.proposal === "object"
      ? (body.proposal as Record<string, unknown>)
      : body;
    const connectionId = toNullableText(body.connectionId ?? proposal.connectionId, 80);
    const partyLedgerName = toText(proposal.partyLedgerName, 500);
    const linkedInvoiceNumber = toText(proposal.linkedInvoiceNumber, 120);

    if (!connectionId) {
      return jsonWithCors(request, { error: "Tally company/connection is required." }, { status: 400 });
    }
    if (!partyLedgerName) {
      return jsonWithCors(request, { error: "Party ledger is required." }, { status: 400 });
    }
    if (!linkedInvoiceNumber) {
      return jsonWithCors(request, { error: "Linked invoice number is required." }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const team=process.env.TEAM_ACCESS_ENFORCEMENT==='true'?await requireMasterDataset(request,connectionId,{companyName:body.companyName||proposal.companyName,financialYear:body.financialYear||proposal.financialYear},'discounts.post'):null;
    let connectionQuery = supabase
      .from("tally_connections")
      .select("id, owner_user_id, last_company_name, status, last_tally_reachable, last_company_loaded, last_heartbeat_at, updated_at")
      .eq("id", connectionId)
      .is("revoked_at", null);
    if(!team)connectionQuery=connectionQuery.eq('owner_user_id',user.id);
    const {data:connection,error:connectionError}=await connectionQuery.maybeSingle();

    if (connectionError) throw connectionError;
    if (!connection) {
      return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
    }

    const companyName = toNullableText(body.companyName ?? proposal.companyName, 240) ?? connection.last_company_name;
    if (!isLiveConnection(connection)) {
      return jsonWithCors(request, { error: "The selected Tally connection is not live." }, { status: 409 });
    }
    if (!companyName || normalizeCompanyName(connection.last_company_name) !== normalizeCompanyName(companyName)) {
      return jsonWithCors(
        request,
        { error: `Tally is currently open to ${connection.last_company_name || "another company"}. Switch it to ${companyName || "the selected company"}, refresh, then create the debit note.` },
        { status: 409 }
      );
    }

    const commands=()=>{
      const query=supabase.from(team?'access_visible_commands':'tally_bridge_commands').select('id, status, payload, result, completed_at, created_at');
      return team?query.eq('organization_id',team.access.organizationId).eq('access_company_id',team.link.company_id)
        .eq('installation_id',team.link.installation_id).eq('company_guid',team.link.company_guid).eq('financial_year',team.link.financial_year).eq('visibility_permission','discounts.view')
        :query.eq('owner_user_id',user.id);
    };
    const proposals=supabase.from('debit_note_proposals').select('party_ledger_name, linked_invoice_number, recoverable_amount, reason_code');
    const [
      { data: openBillCommandRows, error: openBillCommandError },
      { data: createdRows, error: createdRowsError },
      { data: inFlightRows, error: inFlightError },
    ] = await Promise.all([
      commands()
        .eq("connection_id", connection.id)
        .eq("command_type", "fetch_customer_open_bills")
        .eq("status", "succeeded")
        .order("completed_at", { ascending: false })
        .limit(100),
      (team?proposals.eq('access_organization_id',team.access.organizationId).eq('access_company_id',team.link.company_id).eq('financial_year',team.link.financial_year):proposals.eq('owner_user_id',user.id))
        .eq("company_name", companyName)
        .eq("status", "created_in_tally")
        .limit(500),
      commands()
        .eq("connection_id", connection.id)
        .eq("command_type", "create_debit_note")
        .in("status", ["queued", "claimed"])
        .order("created_at", { ascending: false })
        .limit(100),
    ]);

    if (openBillCommandError) throw openBillCommandError;
    if (createdRowsError) throw createdRowsError;
    if (inFlightError) throw inFlightError;

    const companyOpenBillCommands = ((openBillCommandRows ?? []) as unknown as TallyCommandSnapshot[]).filter(
      (command) => normalizeCompanyName(commandCompanyName(command)) === normalizeCompanyName(companyName)
    );
    const newestOpenBillCommand = companyOpenBillCommands[0] ?? null;
    const newestScanId = newestOpenBillCommand ? commandScanId(newestOpenBillCommand) : null;
    const latestOpenBillCommands = newestOpenBillCommand
      ? newestScanId
        ? companyOpenBillCommands.filter((command) => commandScanId(command) === newestScanId)
        : [newestOpenBillCommand]
      : [];
    const matchingBill = latestOpenBillCommands
      .flatMap((command) => readTallyOpenBills(command.result))
      .find((row) => sameInvoice(row, partyLedgerName, linkedInvoiceNumber));

    if (!matchingBill) {
      return jsonWithCors(
        request,
        { error: "The invoice is not present in the latest Tally open-bill scan. Refresh Cash Discounts and review it again." },
        { status: 409 }
      );
    }

    const bill = matchingBill.bill;
    const originalAmount = toNumber(bill.originalAmount);
    const pendingAmount = toNumber(bill.pendingAmount);
    const invoiceDate = toNullableText(bill.invoiceDate, 20);
    const today = businessDateText();
    if (bill.kind === "advance" || originalAmount <= 0 || pendingAmount <= 0) {
      return jsonWithCors(request, { error: "The latest Tally bill is no longer eligible for a debit note." }, { status: 409 });
    }

    const analysis = analyseCashDiscountNarration({
      narration: bill.narration,
      invoiceDate,
      originalAmount,
      pendingAmount,
      receiptDate: bill.receiptDate,
      matchedReceiptAmount: toNumber(bill.matchedReceiptAmount, Number.NaN),
      today,
    });
    if (analysis.deterministicStatus !== "unpaid_discount_tier_expired") {
      return jsonWithCors(
        request,
        { error: `The latest Tally data is not eligible for a debit note: ${analysis.deterministicReason}` },
        { status: 409 }
      );
    }

    const salesLedgerName = toText(bill.sourceSalesLedgerName, 500);
    if (!salesLedgerName) {
      return jsonWithCors(
        request,
        { error: "The original invoice Sales ledger could not be verified. Sync Tally and refresh before creating this debit note." },
        { status: 409 }
      );
    }

    const alreadyCreatedReversalAmount = (createdRows ?? [])
      .filter(
        (row) =>
          String(row.reason_code ?? "").startsWith("cash_discount_") &&
          normalizeCompanyName(row.party_ledger_name) === normalizeCompanyName(matchingBill.ledgerName) &&
          normalizeCompanyName(row.linked_invoice_number) === normalizeCompanyName(linkedInvoiceNumber)
      )
      .reduce((sum, row) => sum + toNumber(row.recoverable_amount), 0);
    const requiredReversalAmount = toNumber(analysis.reversalPlan?.totalReversalRequired);
    const recoverableAmount = Math.max(
      0,
      Math.round((requiredReversalAmount - alreadyCreatedReversalAmount) * 100) / 100
    );
    if (recoverableAmount <= 0.01) {
      return jsonWithCors(
        request,
        { error: "The required cash-discount reversal has already been created in Tally." },
        { status: 409 }
      );
    }

    const duplicateCommand = ((inFlightRows ?? []) as unknown as TallyCommandSnapshot[]).find((command) =>
      commandMatchesInvoice(command, companyName, matchingBill.ledgerName, linkedInvoiceNumber)
    );
    if (duplicateCommand) {
      return jsonWithCors(
        request,
        { error: "A debit-note command for this invoice is already pending in Tally." },
        { status: 409 }
      );
    }

    const masters=supabase.from(team?'access_dataset_masters':'tally_masters').select('tally_name, gstin, parent_name, raw_payload');
    const { data: ledgerData, error: ledgerError } = await (team?masters.eq('dataset_id',team.dataset?.id||'00000000-0000-0000-0000-000000000000'):
      masters.eq('owner_user_id',user.id).eq('connection_id',connection.id).eq('company_name',companyName))
      .eq("master_type", "ledger")
      .eq("tally_name", matchingBill.ledgerName)
      .eq("is_active", true)
      .maybeSingle();
    if (ledgerError) throw ledgerError;

    const ledgerRaw = ledgerData?.raw_payload && typeof ledgerData.raw_payload === "object"
      ? (ledgerData.raw_payload as Record<string, unknown>)
      : {};
    const isTierReversal = analysis.deterministicStatus === "unpaid_discount_tier_expired";
    const referenceSuffix = isTierReversal
      ? `T${analysis.reversalPlan?.activeDiscount?.eligibilityDays ?? "FINAL"}`
      : "SHORT";
    const referenceNumber = `DN-CD-${linkedInvoiceNumber}-${referenceSuffix}`.slice(0, 120);
    const termsLabel = analysis.termsLabel ?? "Cash discount";
    const stagedNarration = analysis.reversalPlan
      ? ` Tally invoice is treated as net after ${analysis.reversalPlan.initialDiscount.ratePercent}%: gross basis ₹${analysis.reversalPlan.grossInvoiceAmount.toLocaleString("en-IN")}; payable now ₹${analysis.reversalPlan.currentPayableAmount.toLocaleString("en-IN")}; cumulative reversal ₹${analysis.reversalPlan.totalReversalRequired.toLocaleString("en-IN")}; already created ₹${alreadyCreatedReversalAmount.toLocaleString("en-IN")}.`
      : "";
    const authoritativeProposal = {
      financialYear: toNullableText(proposal.financialYear, 20),
      partyEmail: toNullableText(ledgerRaw.email, 320),
      partyPhone: toNullableText(ledgerRaw.phone, 80),
      partyContactPerson: toNullableText(ledgerRaw.contactPerson, 240),
      partyAddress: toNullableText(ledgerRaw.address, 1000),
      originalInvoiceAmount: originalAmount,
      cashDiscountRuleId: null,
      cashDiscountRuleName: termsLabel,
      discountDeadline: analysis.discountDeadline,
      receiptDate: analysis.receiptDate,
      amountReceived: Math.max(originalAmount - pendingAmount, 0),
      customerSnapshot: {
        ledgerName: ledgerData?.tally_name ?? matchingBill.ledgerName,
        parentName: ledgerData?.parent_name ?? null,
        gstin: ledgerData?.gstin ?? null,
        email: toNullableText(ledgerRaw.email, 320),
        phone: toNullableText(ledgerRaw.phone, 80),
        contactPerson: toNullableText(ledgerRaw.contactPerson, 240),
        address: toNullableText(ledgerRaw.address, 1000),
        sourceSalesLedgerName: salesLedgerName,
        cashDiscountAnalysis: {
          ...analysis,
          calculationVersion: "cash_discount_v2",
        },
      },
    };
    const commandPayload = {
      companyName,
      partyLedgerName: matchingBill.ledgerName,
      partyGstin: ledgerData?.gstin ?? null,
      linkedInvoiceNumber,
      linkedInvoiceDate: invoiceDate,
      voucherDate: today,
      amount: recoverableAmount,
      // The original open bill stays open. This is an additional charge for
      // the missed discount, posted against the Sales ledger of that invoice.
      adjustOriginalInvoice: false,
      salesLedgerName,
      referenceNumber,
      narration: `Cash discount recovery against invoice ${linkedInvoiceNumber}. Terms: ${termsLabel}.${stagedNarration} Source narration: ${analysis.sourceNarration}`,
      reasonCode: isTierReversal ? "cash_discount_unpaid_tier_reversal" : "cash_discount_narration_expired",
      gstMode: "finance_review",
      sourceProposal: authoritativeProposal,
    };
    if(team) {
      const queued=await enqueueTeamDiscount(team,commandPayload);
      return jsonWithCors(request,{command:serializeTallyBridgeCommand(queued.command),proposalId:queued.proposalId});
    }
    const idempotencyKey = [companyName, matchingBill.ledgerName, linkedInvoiceNumber]
      .map((value) => normalizeCompanyName(value))
      .join("|");

    const { data: commandData, error: commandError } = await supabase
      .from("tally_bridge_commands")
      .insert({
        connection_id: connection.id,
        owner_user_id: user.id,
        command_type: "create_debit_note",
        idempotency_key: idempotencyKey,
        status: "queued",
        priority: 35,
        payload: commandPayload,
      })
      .select("*")
      .single();

    if (commandError) {
      if (commandError.code === "23505") {
        return jsonWithCors(
          request,
          { error: "A debit-note command for this invoice is already pending in Tally." },
          { status: 409 }
        );
      }
      throw commandError;
    }

    await supabase.from("tally_connection_events").insert({
      connection_id: connection.id,
      owner_user_id: user.id,
      event_type: "command_queued",
      message: "Debit note creation queued from Tally open-bill suggestion.",
      payload: {
        commandType: "create_debit_note",
        amount: recoverableAmount,
        partyLedgerName,
      },
    });

    return jsonWithCors(request, {
      command: serializeTallyBridgeCommand(commandData as unknown as TallyBridgeCommandRow),
    });
  } catch (error) {
    const failure=accessFailureResponse(request,error);if(failure)return failure;
    console.error("Error in POST /api/collections/tally-debit-notes/approve:", error);
    return jsonWithCors(
      request,
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export const POST = withTeamAccess(POSTHandler);
