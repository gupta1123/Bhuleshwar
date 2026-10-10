import { withTeamAccess } from '@/lib/access/route-boundary';
import { createHash } from 'node:crypto';
import {requireResourceAccess} from '@/lib/access/resources';
import {requireDataset} from '@/lib/access/dataset';
import {queueProposalOperation} from '@/lib/access/proposal-operations';
import {accessFailureResponse} from '@/lib/access/failures';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { getNativeTallyPdfEvidence, serializeDebitNoteProposal, toNullableText, type DebitNoteProposalRow } from "@/lib/collections";
import { createDebitNotePdfSignedUrl } from "@/lib/debit-notes/pdf";
import { sendDebitNoteWhatsapp, getMsg91WhatsappConfig, normalizeWhatsappPhone, WhatsappRejectedError } from "@/lib/msg91/whatsapp";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function isMissingTableError(error: unknown) {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  return /debit_note_proposals|relation .* does not exist|schema cache/i.test(message);
}

function getTenDigitPhone(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return null;
}

function getSnapshotPhone(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  return getTenDigitPhone((snapshot as Record<string, unknown>).phone);
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = createSupabaseAdminClient();
  let ownerUserId = "";
  let authorizedProposal = false;
  let sendClaimed = false;
  let providerAccepted = false;
  let claimedSnapshot: Record<string, unknown> | null = null;
  let claimVersion = '';

  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }
    ownerUserId = user.id;

    const body = await request.json().catch(() => ({}));
    const config = getMsg91WhatsappConfig();
    if (!config.isConfigured) {
      return jsonWithCors(request, { error: "MSG91 WhatsApp is not configured." }, { status: 409 });
    }

    const team=process.env.TEAM_ACCESS_ENFORCEMENT==='true'?await requireResourceAccess(request,'proposal',id,'discounts.export'):null;
    let proposalQuery = supabase
      .from("debit_note_proposals")
      .select("*")
      .eq("id", id);
    proposalQuery=team?proposalQuery.eq('access_organization_id',team.scope.organization_id).eq('access_company_id',team.scope.company_id):proposalQuery.eq('owner_user_id',user.id);
    const {data:proposalData,error:proposalError}=await proposalQuery.maybeSingle();

    if (proposalError) throw proposalError;
    if (!proposalData) {
      return jsonWithCors(request, { error: "Debit note proposal not found." }, { status: 404 });
    }

    const proposal = proposalData as unknown as DebitNoteProposalRow;
    ownerUserId=proposal.owner_user_id;
    authorizedProposal=true;
    // The dedicated column is the durable lock. Other workflows may refresh
    // customer_snapshot (e.g. PDF export), but must not reopen an uncertain send.
    if (proposal.communication_status === 'drafted') {
      return jsonWithCors(request,{error:'A WhatsApp submission is in progress or needs provider verification. Do not resend yet.'},{status:409});
    }
    if (proposal.status !== "created_in_tally") {
      return jsonWithCors(request, { error: "Create the debit note in Tally before sending WhatsApp." }, { status: 409 });
    }
    if (!proposal.tally_pdf_reference || !getNativeTallyPdfEvidence(proposal.customer_snapshot)) {
      return jsonWithCors(
        request,
        {
          error: "The official Tally PDF is not ready yet. Prepare and verify the Tally document before sending WhatsApp.",
          nativePdfRequired: true,
        },
        { status: 409 }
      );
    }

    const enteredPhone = body.recipientPhone ? getTenDigitPhone(body.recipientPhone) : null;
    if (body.recipientPhone && !enteredPhone) {
      return jsonWithCors(request, { error: "Enter a valid 10-digit WhatsApp number." }, { status: 400 });
    }

    // The dashboard can recover the current number from the synced Tally
    // ledger before the legacy party_phone column is updated. The snapshot is
    // therefore a safe persisted fallback after an explicit dialog value.
    const recipientPhone = normalizeWhatsappPhone(
      enteredPhone ?? getTenDigitPhone(proposal.party_phone) ?? getSnapshotPhone(proposal.customer_snapshot)
    );
    if (!recipientPhone) {
      return jsonWithCors(request, { error: "Customer WhatsApp number is missing." }, { status: 400 });
    }
    const shouldSavePhoneToTally = body.savePhoneToTally === true && Boolean(body.recipientPhone);
    let tallySaveConnectionId = proposal.connection_id;
    if(team&&shouldSavePhoneToTally) {
      const scope=await requireDataset(request,toNullableText(body.connectionId,80)||proposal.connection_id||'',
        {companyId:team.scope.company_id,financialYear:proposal.financial_year},'connections.manage');
      tallySaveConnectionId=scope.connection.id;
    }

    // A proposal can belong to a retired connector after the same company has
    // been paired again. Always use the live connector supplied by the page for
    // a new Tally ledger update, rather than queueing work for an old bridge.
    if (!team && shouldSavePhoneToTally && body.connectionId) {
      const requestedConnectionId = toNullableText(body.connectionId, 80);
      if (!requestedConnectionId) {
        return jsonWithCors(request, { error: "The active Tally connection is invalid." }, { status: 400 });
      }
      const { data: requestedConnection, error: requestedConnectionError } = await supabase
        .from("tally_connections")
        .select("id")
        .eq("id", requestedConnectionId)
        .eq("owner_user_id", user.id)
        .is("revoked_at", null)
        .maybeSingle();
      if (requestedConnectionError) throw requestedConnectionError;
      if (!requestedConnection) {
        return jsonWithCors(request, { error: "The active Tally connection was not found." }, { status: 404 });
      }
      tallySaveConnectionId = requestedConnection.id;
    }

    const storedPdfUrl = await createDebitNotePdfSignedUrl(
      supabase as unknown as Parameters<typeof createDebitNotePdfSignedUrl>[0],
      proposal.tally_pdf_reference,
      60 * 60
    );
    // Only the verified voucher document may be sent, never a browser-supplied URL.
    const documentUrl = storedPdfUrl;
    if (!documentUrl) {
      return jsonWithCors(
        request,
        { error: "Debit note PDF is missing. Recreate the debit note PDF before sending WhatsApp." },
        { status: 400 }
      );
    }

    const documentName =
      toNullableText(body.documentName, 180) ??
      (proposal.tally_voucher_number ? `${proposal.tally_voucher_number}.pdf` : undefined);
    if(team) {
      const {error:permissionError}=await supabase.rpc('access_assert_permission',{p_actor:user.id,p_org:team.scope.organization_id,p_permission:'discounts.export',p_company:team.scope.company_id});
      if(permissionError)throw permissionError;
    }
    // Persist intent BEFORE contacting the provider. A lost response must not
    // permit another paid/customer-visible send, even across API processes.
    const attemptKey = createHash('sha256').update(JSON.stringify([
      proposal.id, recipientPhone, proposal.tally_pdf_reference,
      getNativeTallyPdfEvidence(proposal.customer_snapshot)?.sha256,
    ])).digest('hex');
    const previousAttempt = proposal.customer_snapshot?.whatsappAttempt as { key?: string; state?: string } | undefined;
    const pdfExportedAt = getNativeTallyPdfEvidence(proposal.customer_snapshot)?.exportedAt;
    if (!previousAttempt && proposal.communication_status === 'sent' &&
      (!pdfExportedAt || !proposal.communication_sent_at || Date.parse(pdfExportedAt) <= Date.parse(proposal.communication_sent_at))) {
      return jsonWithCors(request,{proposal:serializeDebitNoteProposal(proposal),sent:true,accepted:true,duplicate:true});
    }
    if (previousAttempt && ['submitting', 'unknown'].includes(previousAttempt.state || '')) {
      return jsonWithCors(request, { error: 'The previous WhatsApp submission needs verification. Do not resend until its provider status is checked.' }, {status:409});
    }
    if (previousAttempt?.key === attemptKey && previousAttempt.state === 'accepted') {
      return jsonWithCors(request, { proposal: serializeDebitNoteProposal(proposal), sent: true, accepted: true, duplicate: true });
    }
    const attemptSnapshot = {
      ...(proposal.customer_snapshot ?? {}),
      whatsappAttempt: { key: attemptKey, state: 'submitting', startedAt: new Date().toISOString() },
    };
    claimVersion = new Date().toISOString();
    const {data: claim, error: claimError} = await supabase.from('debit_note_proposals')
      .update({customer_snapshot: attemptSnapshot, communication_status:'drafted', updated_at:claimVersion})
      .eq('id',proposal.id).eq('owner_user_id',ownerUserId).eq('updated_at',proposal.updated_at)
      .neq('communication_status','drafted').select('id').maybeSingle();
    if (claimError) throw claimError;
    if (!claim) return jsonWithCors(request,{error:'This debit note changed or another submission is running. Refresh its status.'},{status:409});
    sendClaimed = true;
    claimedSnapshot = attemptSnapshot;
    const result = await sendDebitNoteWhatsapp({
      proposal,
      recipientPhone,
      documentUrl,
      documentName,
    });
    providerAccepted = true;

    const now = new Date().toISOString();
    let phoneSaveCommandId: string | null = null;
    let phoneSaveQueueError: string | null = null;
    if (team && shouldSavePhoneToTally && tallySaveConnectionId) {
      try {const queued=await queueProposalOperation(request,proposal.id,tallySaveConnectionId,'phone',recipientPhone.replace(/\D/g,''));phoneSaveCommandId=queued.command.id;}
      catch {phoneSaveQueueError='WhatsApp was sent, but the phone update could not be queued. Check your Tally connection and permission.';}
    } else if (shouldSavePhoneToTally && tallySaveConnectionId) {
      const { data: commandData, error: commandError } = await supabase
        .from("tally_bridge_commands")
        .insert({
          connection_id: tallySaveConnectionId,
          owner_user_id: user.id,
          command_type: "alter_ledger",
          status: "queued",
          payload: {
            oldName: proposal.party_ledger_name,
            newName: proposal.party_ledger_name,
            phoneNumber: recipientPhone,
            companyName: proposal.company_name,
            reason: "cash_discount_whatsapp_phone_capture",
          },
        })
        .select("id")
        .single();

      if (!commandError) {
        phoneSaveCommandId = String(commandData?.id ?? "");
      } else {
        phoneSaveQueueError = "The number could not be queued for saving in Tally.";
        console.warn("Could not queue Tally phone update for debit note WhatsApp:", commandError);
      }
    }

    const { data: updatedData, error: updateError } = await supabase
      .from("debit_note_proposals")
      .update({
        party_phone: recipientPhone,
        communication_status: "sent",
        communication_channel: "whatsapp",
        communication_recipient: recipientPhone,
        communication_sent_at: now,
        customer_snapshot: {
          ...attemptSnapshot,
          whatsappAttempt: { ...attemptSnapshot.whatsappAttempt, state: 'accepted', acceptedAt: now },
          phone: recipientPhone,
          whatsapp: {
            provider: "msg91",
            senderNumber: config.senderNumber,
            templateName: config.templateName,
            templateMode: config.templateMode,
            sentAt: now,
            phoneSaveCommandId,
            response: result.payload,
          },
        },
        last_error: null,
        updated_at: now,
      })
      .eq("id", proposal.id)
      .eq("owner_user_id", ownerUserId)
      .eq('communication_status','drafted').eq('updated_at',claimVersion)
      .select("*")
      .single();

    if (updateError) throw updateError;

    return jsonWithCors(request, {
      proposal: serializeDebitNoteProposal(updatedData as unknown as DebitNoteProposalRow),
      sent: true,
      accepted: true,
      phoneSaveCommandId: phoneSaveCommandId || null,
      phoneSaveConnectionId: phoneSaveCommandId ? tallySaveConnectionId : null,
      phoneSaveQueueError,
    });
  } catch (error) {
    if (sendClaimed && !providerAccepted && error instanceof WhatsappRejectedError) {
      const {error:saveError} = await supabase.from('debit_note_proposals').update({
        communication_status:'failed',last_error:error.message,updated_at:new Date().toISOString(),
        customer_snapshot:{...claimedSnapshot,whatsappAttempt:{...(claimedSnapshot?.whatsappAttempt as Record<string,unknown>),state:'rejected'}},
      }).eq('id',id).eq('owner_user_id',ownerUserId).eq('communication_status','drafted').eq('updated_at',claimVersion);
      if (!saveError) return jsonWithCors(request,{error:error.message},{status:422});
    }
    if (sendClaimed) {
      // Leave the durable intent unresolved on uncertainty. Never turn an
      // accepted send into a retryable failure because a later DB write failed.
      const message = providerAccepted
        ? 'WhatsApp was accepted by the provider, but its saved status could not be updated. Do not resend; verify provider status.'
        : 'WhatsApp submission outcome is uncertain. Verify provider status before trying again.';
      return jsonWithCors(request, {error:message, accepted:providerAccepted, verificationRequired:true}, {status:providerAccepted?202:409});
    }
    const failure=accessFailureResponse(request,error);if(failure)return failure;
    if (isMissingTableError(error)) {
      return jsonWithCors(
        request,
        { error: "Run the collections debit-note history migration before sending WhatsApp messages.", setupRequired: true },
        { status: 409 }
      );
    }

    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("Error in POST /api/collections/debit-note-proposals/[id]/whatsapp:", error);

    if (id && authorizedProposal && ownerUserId && sendClaimed) {
      let query = supabase
        .from("debit_note_proposals")
        .update({
          communication_status: "failed",
          communication_channel: "whatsapp",
          last_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (ownerUserId) {
        query = query.eq("owner_user_id", ownerUserId);
      }
      await query;
    }

    return jsonWithCors(request, { error: message }, { status: 500 });
  }
}

export const POST = withTeamAccess(POSTHandler);
