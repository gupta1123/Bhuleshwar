import { withTeamAccess } from '@/lib/access/route-boundary';
import {requireResourceAccess} from '@/lib/access/resources';
import {accessFailureResponse} from '@/lib/access/failures';
import {queueProposalOperation} from '@/lib/access/proposal-operations';
import { applyCorsHeaders, jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { NextResponse } from "next/server";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  createDebitNotePdfSignedUrl,
} from "@/lib/debit-notes/pdf";
import {
  getNativeTallyPdfEvidence,
  serializeDebitNoteProposal,
  toNullableText,
  type DebitNoteProposalRow,
} from "@/lib/collections";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { serializeTallyBridgeCommand, type TallyBridgeCommandRow } from "@/lib/tally/commands";

function normalizeCompanyName(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isLiveConnection(row: { status?: string | null; last_tally_reachable?: boolean | null; last_company_loaded?: boolean | null }) {
  return row.status === "company_loaded" || (row.last_tally_reachable === true && row.last_company_loaded === true);
}

function debitNotePdfFilename(proposal: DebitNoteProposalRow) {
  const voucherNumber = String(proposal.tally_voucher_number ?? "tally-debit-note")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return `${voucherNumber || "tally-debit-note"}.pdf`;
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function GETHandler(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    const { id } = await context.params;
    const supabase = createSupabaseAdminClient();
    const team=process.env.TEAM_ACCESS_ENFORCEMENT==='true'
      ?await requireResourceAccess(request,'proposal',id,'discounts.export'):null;
    let query = supabase
      .from("debit_note_proposals")
      .select("*")
      .eq("id", id);
    query=team?query.eq('access_organization_id',team.scope.organization_id).eq('access_company_id',team.scope.company_id)
      :query.eq('owner_user_id',user.id);
    const {data,error}=await query.maybeSingle();
    if (error) throw error;
    if (!data) return jsonWithCors(request, { error: "Debit note proposal not found." }, { status: 404 });

    const proposal = data as unknown as DebitNoteProposalRow;
    if (!proposal.tally_pdf_reference || !getNativeTallyPdfEvidence(proposal.customer_snapshot)) {
      return jsonWithCors(request, { error: "The verified native Tally PDF is not ready yet." }, { status: 409 });
    }
    const url = await createDebitNotePdfSignedUrl(
      supabase as unknown as Parameters<typeof createDebitNotePdfSignedUrl>[0],
      proposal.tally_pdf_reference,
      60 * 10
    );
    if (!url) return jsonWithCors(request, { error: "The verified native Tally PDF could not be opened." }, { status: 404 });

    if (team || new URL(request.url).searchParams.get("download") === "1") {
      const sourceResponse = await fetch(url);
      if (!sourceResponse.ok) {
        return jsonWithCors(request, { error: "The verified Tally PDF could not be downloaded." }, { status: 502 });
      }
      const response = new NextResponse(await sourceResponse.arrayBuffer(), {
        headers: {
          "Content-Type": sourceResponse.headers.get("content-type") ?? "application/pdf",
          "Content-Disposition": `attachment; filename="${debitNotePdfFilename(proposal)}"`,
          "Cache-Control": "private, no-store",
        },
      });
      return applyCorsHeaders(response, request);
    }

    return jsonWithCors(request, { url });
  } catch (error) {
    const failure=accessFailureResponse(request,error);if(failure)return failure;
    console.error("Error in GET /api/collections/debit-note-proposals/[id]/native-pdf:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
  }
}

async function POSTHandler(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const requestedConnectionId = toNullableText(body.connectionId, 80);
    if(process.env.TEAM_ACCESS_ENFORCEMENT==='true') {
      const queued=await queueProposalOperation(request,id,requestedConnectionId||undefined,'native_pdf');
      return jsonWithCors(request,{command:serializeTallyBridgeCommand(queued.command),pending:true,proposal:serializeDebitNoteProposal(queued.proposal)});
    }
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("debit_note_proposals")
      .select("*")
      .eq("id", id)
      .eq("owner_user_id", user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return jsonWithCors(request, { error: "Debit note proposal not found." }, { status: 404 });

    let proposal = data as unknown as DebitNoteProposalRow;

    // A dashboard refresh can briefly retain an older failed proposal while
    // its create command has already been repaired into a created proposal.
    // Resolve that canonical row rather than rejecting an otherwise valid
    // official-PDF request. This is also safe for historical commands that
    // were reconciled after the original proposal failed.
    if (proposal.status !== "created_in_tally" && proposal.tally_command_id) {
      const { data: canonicalData, error: canonicalError } = await supabase
        .from("debit_note_proposals")
        .select("*")
        .eq("owner_user_id", user.id)
        .eq("tally_command_id", proposal.tally_command_id)
        .eq("status", "created_in_tally")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (canonicalError) throw canonicalError;
      if (canonicalData) proposal = canonicalData as unknown as DebitNoteProposalRow;
    }

    if (proposal.status !== "created_in_tally") {
      return jsonWithCors(request, { error: "Create the Debit Note in Tally before preparing its official PDF." }, { status: 409 });
    }
    if (proposal.tally_pdf_reference && getNativeTallyPdfEvidence(proposal.customer_snapshot)) {
      return jsonWithCors(request, { ready: true, proposal: serializeDebitNoteProposal(proposal) });
    }

    const connectionId = requestedConnectionId ?? proposal.connection_id;
    if (!connectionId) return jsonWithCors(request, { error: "A live Tally connection is required." }, { status: 409 });
    const { data: connection, error: connectionError } = await supabase
      .from("tally_connections")
      .select("id, owner_user_id, last_company_name, status, last_tally_reachable, last_company_loaded")
      .eq("id", connectionId)
      .eq("owner_user_id", user.id)
      .is("revoked_at", null)
      .maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection) return jsonWithCors(request, { error: "The active Tally connection was not found." }, { status: 404 });
    if (!isLiveConnection(connection)) {
      return jsonWithCors(request, { error: "The active Tally connection is not live." }, { status: 409 });
    }
    if (!proposal.company_name || normalizeCompanyName(connection.last_company_name) !== normalizeCompanyName(proposal.company_name)) {
      return jsonWithCors(
        request,
        { error: `Tally is currently open to ${connection.last_company_name || "another company"}. Switch it to ${proposal.company_name || "the Debit Note company"}, refresh, then try again.` },
        { status: 409 }
      );
    }

    const { data: existingCommand, error: existingCommandError } = await supabase
      .from("tally_bridge_commands")
      .select("*")
      .eq("owner_user_id", user.id)
      .eq("connection_id", connection.id)
      // Reuse the established command type so this works against already
      // deployed databases whose command-type check has not been migrated.
      .eq("command_type", "create_debit_note")
      .in("status", ["queued", "claimed"])
      .contains("payload", { proposalId: proposal.id, operation: "export_native_pdf" })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingCommandError) throw existingCommandError;
    if (existingCommand) {
      return jsonWithCors(request, {
        command: serializeTallyBridgeCommand(existingCommand as unknown as TallyBridgeCommandRow),
        pending: true,
        proposal: serializeDebitNoteProposal(proposal),
      });
    }

    const referenceNumber = proposal.tally_open_reference_name || proposal.tally_voucher_number;
    const { data: commandData, error: commandError } = await supabase
      .from("tally_bridge_commands")
      .insert({
        connection_id: connection.id,
        owner_user_id: user.id,
        command_type: "create_debit_note",
        status: "queued",
        priority: 45,
        payload: {
          proposalId: proposal.id,
          operation: "export_native_pdf",
          companyName: proposal.company_name,
          tallyVoucherId: proposal.tally_voucher_id,
          tallyVoucherNumber: proposal.tally_voucher_number,
          voucherDate: proposal.tally_voucher_date ?? proposal.debit_note_date,
          referenceNumber,
          partyLedgerName: proposal.party_ledger_name,
          amount: Number(proposal.recoverable_amount),
          narration: proposal.narration,
          linkedInvoiceNumber: proposal.linked_invoice_number,
        },
      })
      .select("*")
      .single();
    if (commandError) throw commandError;

    return jsonWithCors(request, {
      command: serializeTallyBridgeCommand(commandData as unknown as TallyBridgeCommandRow),
      pending: true,
      proposal: serializeDebitNoteProposal(proposal),
    });
  } catch (error) {
    const failure=accessFailureResponse(request,error);if(failure)return failure;
    console.error("Error in POST /api/collections/debit-note-proposals/[id]/native-pdf:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);
export const POST = withTeamAccess(POSTHandler);
