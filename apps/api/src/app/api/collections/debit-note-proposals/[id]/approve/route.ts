import { withTeamAccess } from '@/lib/access/route-boundary';
import {requireResourceAccess} from '@/lib/access/resources';
import {requireDataset} from '@/lib/access/dataset';
import {enqueueTeamDiscount} from '@/lib/access/discount-writes';
import {accessFailureResponse} from '@/lib/access/failures';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  serializeDebitNoteProposal,
  toNumber,
  toText,
  type DebitNoteProposalRow,
} from "@/lib/collections";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { serializeTallyBridgeCommand, type TallyBridgeCommandRow } from "@/lib/tally/commands";

function isMissingTableError(error: unknown) {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  return /debit_note_proposals|relation .* does not exist|schema cache/i.test(message);
}

function toTallyCompanyName(value: unknown) {
  const text = String(value ?? "").trim();
  return text && !/^tally prime$/i.test(text) ? text : null;
}

function isLiveConnection(row: { status?: string | null; last_tally_reachable?: boolean | null; last_company_loaded?: boolean | null }) {
  return row.status === "company_loaded" || (row.last_tally_reachable === true && row.last_company_loaded === true);
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const supabase = createSupabaseAdminClient();
    if(process.env.TEAM_ACCESS_ENFORCEMENT==='true') {
      const resource=await requireResourceAccess(request,'proposal',id,'discounts.post');
      const {data:proposal,error}=await supabase.from('debit_note_proposals').select('*').eq('id',id)
        .eq('access_organization_id',resource.scope.organization_id).eq('access_company_id',resource.scope.company_id).maybeSingle();
      if(error)throw error;
      if(!proposal?.connection_id)return jsonWithCors(request,{error:'A verified proposal connection is required.'},{status:409});
      const scope=await requireDataset(request,proposal.connection_id,{companyId:resource.scope.company_id,financialYear:proposal.financial_year,companyName:proposal.company_name},'discounts.post');
      const queued=await enqueueTeamDiscount(scope,{},id);
      return jsonWithCors(request,{proposal:serializeDebitNoteProposal({...proposal,status:'queued_in_tally',tally_command_id:queued.command.id}),command:serializeTallyBridgeCommand(queued.command)});
    }
    const { data: proposalData, error: proposalError } = await supabase
      .from("debit_note_proposals")
      .select("*")
      .eq("id", id)
      .eq("owner_user_id", user.id)
      .maybeSingle();

    if (proposalError) throw proposalError;
    if (!proposalData) {
      return jsonWithCors(request, { error: "Debit note proposal not found." }, { status: 404 });
    }

    const proposal = proposalData as unknown as DebitNoteProposalRow;
    if (!["draft", "pending_approval", "failed"].includes(proposal.status)) {
      return jsonWithCors(
        request,
        { error: `Proposal cannot be approved from status ${proposal.status}.` },
        { status: 409 }
      );
    }
    if (!proposal.connection_id) {
      return jsonWithCors(request, { error: "Proposal is missing a Tally connection." }, { status: 400 });
    }
    if (toNumber(proposal.recoverable_amount) <= 0) {
      return jsonWithCors(request, { error: "Recoverable amount must be greater than zero." }, { status: 400 });
    }
    const salesLedgerName = toText(proposal.customer_snapshot?.sourceSalesLedgerName, 500);
    if (!salesLedgerName) {
      return jsonWithCors(
        request,
        { error: "The original invoice Sales ledger is not available for this saved proposal. Sync Tally and refresh to regenerate it safely." },
        { status: 409 }
      );
    }

    const { data: connection, error: connectionError } = await supabase
      .from("tally_connections")
      .select("id, owner_user_id, last_company_name, status, last_tally_reachable, last_company_loaded, last_heartbeat_at, updated_at")
      .eq("id", proposal.connection_id)
      .eq("owner_user_id", user.id)
      .is("revoked_at", null)
      .maybeSingle();

    if (connectionError) throw connectionError;
    if (!connection) {
      return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
    }

    let commandConnection = connection;
    const proposalCompanyName = toTallyCompanyName(proposal.company_name) || toTallyCompanyName(connection.last_company_name);

    if (proposalCompanyName) {
      const { data: liveRows, error: liveError } = await supabase
        .from("tally_connections")
        .select("id, owner_user_id, last_company_name, status, last_tally_reachable, last_company_loaded, last_heartbeat_at, updated_at")
        .eq("owner_user_id", user.id)
        .eq("last_company_name", proposalCompanyName)
        .is("revoked_at", null)
        .order("last_heartbeat_at", { ascending: false, nullsFirst: false })
        .order("updated_at", { ascending: false })
        .limit(20);

      if (liveError) throw liveError;
      commandConnection = (liveRows ?? []).find(isLiveConnection) ?? connection;
    }

    const commandPayload = {
      proposalId: proposal.id,
      companyName: proposalCompanyName,
      partyLedgerName: proposal.party_ledger_name,
      partyGstin: proposal.party_gstin,
      linkedInvoiceNumber: proposal.linked_invoice_number,
      linkedInvoiceDate: proposal.linked_invoice_date,
      voucherDate: proposal.debit_note_date,
      amount: toNumber(proposal.recoverable_amount),
      adjustOriginalInvoice: false,
      salesLedgerName,
      referenceNumber: proposal.linked_invoice_number
        ? `DN-CD-${proposal.linked_invoice_number}`.slice(0, 120)
        : `DN-CD-${proposal.id.slice(0, 8)}`,
      narration: proposal.narration,
      reasonCode: proposal.reason_code,
      gstMode: proposal.gst_mode,
    };

    const { data: commandData, error: commandError } = await supabase
      .from("tally_bridge_commands")
      .insert({
        connection_id: commandConnection.id,
        owner_user_id: user.id,
        command_type: "create_debit_note",
        status: "queued",
        priority: 35,
        payload: commandPayload,
      })
      .select("*")
      .single();

    if (commandError) throw commandError;
    const command = commandData as unknown as TallyBridgeCommandRow;

    const now = new Date().toISOString();
    const { data: updatedData, error: updateError } = await supabase
      .from("debit_note_proposals")
      .update({
        status: "queued_in_tally",
        connection_id: commandConnection.id,
        approval_by: user.id,
        approved_at: now,
        tally_command_id: command.id,
        updated_at: now,
        last_error: null,
      })
      .eq("id", proposal.id)
      .eq("owner_user_id", user.id)
      .select("*")
      .single();

    if (updateError) throw updateError;

    await supabase.from("tally_connection_events").insert({
      connection_id: commandConnection.id,
      owner_user_id: user.id,
      event_type: "command_queued",
      message: "Debit note creation queued for bridge.",
      payload: {
        commandType: "create_debit_note",
        proposalId: proposal.id,
        amount: commandPayload.amount,
        commandConnectionId: commandConnection.id,
      },
    });

    return jsonWithCors(request, {
      proposal: serializeDebitNoteProposal(updatedData as unknown as DebitNoteProposalRow),
      command: serializeTallyBridgeCommand(command),
    });
  } catch (error) {
    const failure=accessFailureResponse(request,error);if(failure)return failure;
    if (isMissingTableError(error)) {
      return jsonWithCors(
        request,
        { error: "Run the collections cash discount migration before approving proposals.", setupRequired: true },
        { status: 409 }
      );
    }

    console.error("Error in POST /api/collections/debit-note-proposals/[id]/approve:", error);
    return jsonWithCors(
      request,
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export const POST = withTeamAccess(POSTHandler);
