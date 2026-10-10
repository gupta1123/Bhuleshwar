import { withTeamAccess } from '@/lib/access/route-boundary';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  serializeDebitNoteProposal,
  toNumber,
  type DebitNoteProposalRow,
} from "@/lib/collections";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashSecret, TALLY_CONNECTION_SELECT, type TallyConnectionRow } from "@/lib/tally/connections";
import { toNullableText } from "@/lib/tally/masters";
import { businessDateText } from "@/lib/business-date";

function bridgeToken(request: Request) {
  return request.headers.get("x-bridge-token") ?? "";
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function POSTHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    if(process.env.TEAM_ACCESS_ENFORCEMENT==='true')return jsonWithCors(request,
      {error:'Team debit notes are recorded by the authenticated issued-command callback. Refresh the command status.'},{status:409});

    const body = await request.json().catch(() => ({}));
    const connectionId = toNullableText(body.connectionId, 80);
    const commandPayload = body.commandPayload && typeof body.commandPayload === "object"
      ? (body.commandPayload as Record<string, unknown>)
      : null;
    const tallyOutcome = body.tallyOutcome && typeof body.tallyOutcome === "object"
      ? (body.tallyOutcome as Record<string, unknown>)
      : null;
    const token = bridgeToken(request);

    if (!connectionId || !commandPayload || !tallyOutcome || !token) {
      return jsonWithCors(request, { error: "A verified live Tally result is required." }, { status: 400 });
    }
    if (tallyOutcome.success !== true) {
      return jsonWithCors(request, { error: "Tally did not confirm creation of the Debit Note." }, { status: 409 });
    }

    const result = tallyOutcome.result && typeof tallyOutcome.result === "object"
      ? (tallyOutcome.result as Record<string, unknown>)
      : {};
    const voucherId = toNullableText(result.voucherId ?? result.masterId, 500);
    const voucherGuid = toNullableText(result.voucherGuid ?? result.guid, 500);
    const voucherNumber = toNullableText(result.voucherNumber, 500) ??
      toNullableText(commandPayload.referenceNumber, 500) ?? voucherId;
    const voucherDate = toNullableText(result.voucherDate, 20) ??
      toNullableText(commandPayload.voucherDate, 20);
    const openReferenceName = toNullableText(result.openReferenceName, 500) ??
      toNullableText(commandPayload.referenceNumber, 500) ?? voucherNumber;
    if (!voucherId || !voucherNumber) {
      return jsonWithCors(request, { error: "Tally did not return a verifiable Debit Note identity." }, { status: 409 });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .eq("id", connectionId)
      .eq("owner_user_id", user.id)
      .maybeSingle();
    if (error) throw error;
    const connection = data as unknown as TallyConnectionRow | null;
    if (!connection || connection.revoked_at) {
      return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
    }
    if (!connection.bridge_token_hash || hashSecret(token) !== connection.bridge_token_hash) {
      return jsonWithCors(request, { error: "The confirming connector is not authenticated." }, { status: 401 });
    }

    const duplicateQuery = supabase
      .from("debit_note_proposals")
      .select("*")
      .eq("owner_user_id", user.id)
      .eq("connection_id", connectionId)
      .eq("status", "created_in_tally");
    const { data: duplicateData, error: duplicateError } = voucherGuid
      ? await duplicateQuery.eq("tally_voucher_guid", voucherGuid).limit(1).maybeSingle()
      : await duplicateQuery.eq("tally_voucher_id", voucherId).limit(1).maybeSingle();
    if (duplicateError) throw duplicateError;
    if (duplicateData) {
      return jsonWithCors(request, {
        proposal: serializeDebitNoteProposal(duplicateData as unknown as DebitNoteProposalRow),
        duplicate: true,
      });
    }

    const sourceProposal = commandPayload.sourceProposal && typeof commandPayload.sourceProposal === "object"
      ? (commandPayload.sourceProposal as Record<string, unknown>)
      : {};
    const now = new Date().toISOString();
    const amount = toNumber(commandPayload.amount);
    const { data: inserted, error: insertError } = await supabase
      .from("debit_note_proposals")
      .insert({
        owner_user_id: user.id,
        connection_id: connectionId,
        company_name: toNullableText(commandPayload.companyName, 240) ?? connection.last_company_name,
        financial_year: toNullableText(sourceProposal.financialYear, 20),
        source_transaction_id: null,
        party_ledger_name: toNullableText(commandPayload.partyLedgerName, 500) ?? "Unknown party",
        party_gstin: toNullableText(commandPayload.partyGstin, 32),
        party_email: toNullableText(sourceProposal.partyEmail, 320),
        party_phone: toNullableText(sourceProposal.partyPhone, 80),
        party_contact_person: toNullableText(sourceProposal.partyContactPerson, 240),
        party_address: toNullableText(sourceProposal.partyAddress, 1000),
        linked_invoice_number: toNullableText(commandPayload.linkedInvoiceNumber, 120),
        linked_invoice_date: toNullableText(commandPayload.linkedInvoiceDate, 20),
        original_invoice_amount: toNumber(sourceProposal.originalInvoiceAmount) || null,
        cash_discount_rule_id: toNullableText(sourceProposal.cashDiscountRuleId, 80),
        cash_discount_rule_name: toNullableText(sourceProposal.cashDiscountRuleName, 160),
        discount_deadline: toNullableText(sourceProposal.discountDeadline, 20),
        receipt_date: toNullableText(sourceProposal.receiptDate, 20),
        amount_received: toNumber(sourceProposal.amountReceived) || null,
        recoverable_amount: amount,
        reason_code: toNullableText(commandPayload.reasonCode, 80) ?? "cash_discount_expired",
        narration: toNullableText(commandPayload.narration, 1000),
        gst_mode: toNullableText(commandPayload.gstMode, 80) ?? "finance_review",
        debit_note_date: voucherDate ?? businessDateText(),
        status: "created_in_tally",
        approval_by: user.id,
        approved_at: now,
        tally_command_id: null,
        tally_voucher_guid: voucherGuid,
        tally_voucher_id: voucherId,
        tally_voucher_number: voucherNumber,
        tally_voucher_date: voucherDate,
        tally_open_reference_name: openReferenceName,
        remaining_recoverable_amount: amount,
        created_in_tally_at: now,
        last_synced_from_tally_at: now,
        communication_status: "not_sent",
        customer_snapshot: sourceProposal.customerSnapshot ?? {},
        last_error: null,
      })
      .select("*")
      .single();
    if (insertError) {
      if (insertError.code === "23505") {
        const retryQuery = supabase
          .from("debit_note_proposals")
          .select("*")
          .eq("owner_user_id", user.id)
          .eq("connection_id", connectionId)
          .eq("status", "created_in_tally");
        const { data: existing, error: existingError } = voucherGuid
          ? await retryQuery.eq("tally_voucher_guid", voucherGuid).limit(1).maybeSingle()
          : await retryQuery.eq("tally_voucher_id", voucherId).limit(1).maybeSingle();
        if (existingError) throw existingError;
        if (existing) {
          return jsonWithCors(request, {
            proposal: serializeDebitNoteProposal(existing as unknown as DebitNoteProposalRow),
            duplicate: true,
          });
        }
      }
      throw insertError;
    }

    return jsonWithCors(request, {
      proposal: serializeDebitNoteProposal(inserted as unknown as DebitNoteProposalRow),
    });
  } catch (error) {
    console.error("Error in POST /api/collections/live/confirm-debit-note:", error);
    return jsonWithCors(
      request,
      { error: error instanceof Error ? error.message : "Could not save the confirmed Debit Note." },
      { status: 500 }
    );
  }
}

export const POST = withTeamAccess(POSTHandler);
