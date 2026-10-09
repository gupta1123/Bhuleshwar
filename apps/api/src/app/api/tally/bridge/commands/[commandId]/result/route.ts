import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { completeTeamPurchase } from '@/lib/access/purchase-completion';
import { accessFailureResponse } from '@/lib/access/failures';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { isLocalDbMode } from "@/lib/local/mode";
import { completeLocalTallyCommand } from "@/lib/local/tally-store";
import {
  hashSecret,
  TALLY_CONNECTION_SELECT,
  type TallyConnectionRow,
} from "@/lib/tally/connections";
import {
  serializeTallyBridgeCommand,
  type TallyBridgeCommandRow,
} from "@/lib/tally/commands";
import { toNullableText } from "@/lib/tally/masters";
import { normalizeMasterKey } from "@/lib/tally/masters";
import { releaseTallyMasterSyncLock } from "@/lib/tally/master-sync-lock";

function getBridgeToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1] ?? request.headers.get("x-bridge-token") ?? "";
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

function positiveTallyId(value: unknown) {
  const text = toNullableText(value, 500);
  return text && text !== "0" ? text : null;
}

function compactPurchaseResult(result: Record<string, unknown>) {
  const verification = result.verification && typeof result.verification === "object"
    ? result.verification as Record<string, unknown>
    : result;
  const importSummary = {
    httpStatus: result.httpStatus ?? null,
    created: result.created ?? null,
    altered: result.altered ?? null,
    errors: result.errors ?? null,
    exceptions: result.exceptions ?? null,
    ignored: result.ignored ?? null,
    cancelled: result.cancelled ?? null,
    lastVchId: positiveTallyId(result.lastVchId),
  };
  const verifiedAbsent = result.verifiedAbsent === true || result.voucherCreated === false;
  const rawTimings = result.timings && typeof result.timings === "object"
    ? result.timings as Record<string, unknown>
    : {};
  const timings = Object.fromEntries(
    Object.entries(rawTimings).flatMap(([key, value]) => {
      const milliseconds = Number(value);
      return /^[a-z][a-zA-Z]*Ms$/.test(key) && Number.isFinite(milliseconds) && milliseconds >= 0
        ? [[key, Math.round(milliseconds)]]
        : [];
    })
  );
  return {
    verificationStatus: verification.verificationStatus ?? null,
    differences: Array.isArray(verification.differences)
      ? verification.differences
          .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
          .slice(0, 20)
          .map((value) => value.trim().slice(0, 500))
      : [],
    voucherNumber: verifiedAbsent ? null : verification.voucherNumber ?? result.voucherNumber ?? null,
    masterId: verifiedAbsent
      ? null
      : positiveTallyId(verification.masterId) ??
        positiveTallyId(verification.voucherId) ??
        positiveTallyId(result.lastVchId),
    guid: verifiedAbsent ? null : verification.guid ?? result.guid ?? null,
    uncertainWrite: result.uncertainWrite === true,
    uncertaintyReason: toNullableText(result.uncertaintyReason, 100),
    verificationOnly: result.verificationOnly === true,
    verifiedAbsent: result.verifiedAbsent === true,
    voucherCreated: verifiedAbsent ? false : Boolean(
      result.voucherCreatedButVerificationFailed ||
      Number(result.created ?? 0) > 0 ||
      verification.voucherNumber ||
      positiveTallyId(verification.masterId) ||
      positiveTallyId(verification.voucherId) ||
      positiveTallyId(result.lastVchId)
    ),
    importSummary,
    timings,
    tallyResponse: toNullableText(result.response, 4000),
  };
}

function purchaseVerificationError(
  fallback: string | null,
  verification: Record<string, unknown>
) {
  const differences = Array.isArray(verification.differences)
    ? verification.differences
        .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        .slice(0, 5)
        .map((value) => value.trim())
    : [];
  if (differences.length > 0) {
    return `Tally created the voucher, but these checks need attention: ${differences.join(" ")}`.slice(0, 2000);
  }
  return fallback;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ commandId: string }> }
) {
  try {
    const token = getBridgeToken(request);
    const body = await request.json().catch(() => ({}));
    const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";

    if (!connectionId || !token) {
      return jsonWithCors(request, { error: "Connection id and bridge token are required." }, { status: 400 });
    }

    const { commandId } = await context.params;
    const success = body.status === "succeeded" || body.success === true;
    const rawResult = body.result && typeof body.result === "object" ? body.result as Record<string, unknown> : {};
    const result = { ...rawResult };
    delete result.nativePdfBase64;
    const errorMessage = success ? null : toNullableText(body.error, 2000) ?? "Tally command failed.";
    const reportedIdentity = body.identity && typeof body.identity === "object"
      ? body.identity as Record<string, unknown>
      : null;

    if (isLocalDbMode()) {
      const completed = await completeLocalTallyCommand({
        connectionId,
        token,
        commandId,
        success,
        result,
        error: errorMessage,
      });

      if (completed.unauthorized) {
        return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
      }

      if (!completed.command) {
        return jsonWithCors(request, { error: "Tally command not found." }, { status: 404 });
      }

      if (completed.command.command_type === "sync_masters") {
        const payload = completed.command.payload && typeof completed.command.payload === "object"
          ? completed.command.payload as Record<string, unknown>
          : {};
        await releaseTallyMasterSyncLock({
          supabase: null,
          local: true,
          connectionId,
          token: typeof payload.syncLockToken === "string" ? payload.syncLockToken : null,
        });
      }

      return jsonWithCors(request, {
        command: serializeTallyBridgeCommand(completed.command),
      });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .eq("id", connectionId)
      .maybeSingle();

    if (error) throw error;

    const connection = data as unknown as TallyConnectionRow | null;
    if (connection?.revoked_at) {
      return jsonWithCors(
        request,
        { error: "This connector session has been revoked. Reconnect this computer." },
        { status: 409 }
      );
    }
    if (!connection?.bridge_token_hash || hashSecret(token) !== connection.bridge_token_hash) {
      return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
    }

    const now = new Date().toISOString();

    const { data: pendingCommandData, error: pendingCommandError } = await supabase
      .from("tally_bridge_commands")
      .select("*")
      .eq("id", commandId)
      .eq("connection_id", connection.id)
      .in("status", process.env.TEAM_ACCESS_ENFORCEMENT === 'true'
        ? ["claimed", "queued", "succeeded", "failed"] : ["claimed", "queued"])
      .maybeSingle();

    if (pendingCommandError) throw pendingCommandError;
    if (!pendingCommandData) {
      return jsonWithCors(request, { error: "Tally command not found." }, { status: 404 });
    }

    const pendingCommand = pendingCommandData as unknown as TallyBridgeCommandRow;
    const commandPayload =
      pendingCommand.payload && typeof pendingCommand.payload === "object"
        ? (pendingCommand.payload as Record<string, unknown>)
        : {};
    const isPurchaseVoucher = pendingCommand.command_type === "create_purchase_voucher";
    if (Number(pendingCommand.protocol_version || 0) >= 1) {
      const mismatched = !reportedIdentity ||
        String(reportedIdentity.connectionId || "") !== pendingCommand.connection_id ||
        String(reportedIdentity.installationId || "") !== String(pendingCommand.installation_id || "") ||
        Number(reportedIdentity.sessionGeneration || 0) !== Number(pendingCommand.session_generation || 0) ||
        String(reportedIdentity.companyGuid || "") !== String(pendingCommand.company_guid || "") ||
        String(reportedIdentity.financialYear || "") !== String(pendingCommand.financial_year || "");
      if (mismatched) {
        return jsonWithCors(request, { error: "Agent result identity does not match the claimed job." }, { status: 409 });
      }
    }

    if (process.env.TEAM_ACCESS_ENFORCEMENT === 'true' && isPurchaseVoucher) {
      if (reportedIdentity?.organizationId !== pendingCommand.organization_id ||
          reportedIdentity?.ownerUserId !== pendingCommand.owner_user_id) {
        return jsonWithCors(request, { error: 'Result organization or paired owner does not match the issued command.' }, { status: 409 });
      }
      const completed = await completeTeamPurchase({
        db: supabase, commandId, connectionId: connection.id, bridgeTokenHash: hashSecret(token),
        success, result, compactResult: compactPurchaseResult(result), error: errorMessage,
      });
      return jsonWithCors(request, { command: serializeTallyBridgeCommand(completed as TallyBridgeCommandRow) });
    }
    if (!['claimed', 'queued'].includes(pendingCommand.status)) {
      return jsonWithCors(request, { error: 'This command is already terminal.' }, { status: 409 });
    }

    // Completion must follow durable debit-note history/PDF storage.
    const { data: commandData, error: updateError } = await supabase
      .from("tally_bridge_commands")
      .update({
        status: success ? "succeeded" : "failed",
        // Keep the frozen canonical Purchase revision for a safe verification
        // pass after a timeout or connector restart.
        payload: commandPayload,
        result: isPurchaseVoucher ? compactPurchaseResult(result) : result,
        error: errorMessage,
        completed_at: now,
        agent_receipt: toNullableText(body.agentReceipt, 500),
        external_result_reference: toNullableText(body.externalResultReference, 1000),
      })
      .eq("id", commandId)
      .eq("connection_id", connection.id)
      .in("status", ["claimed", "queued"])
        // Return only the id here. The full command payload was already read
        // above; returning it again made result callbacks unnecessarily large
        // and could hit Supabase statement timeouts for voucher commands.
        .select("id")
        .maybeSingle();

    if (updateError) throw updateError;
    if (!commandData) {
      return jsonWithCors(request, { error: "Tally command not found." }, { status: 404 });
    }

    // Completing a command proves that the paired connector is still alive.
    // Purchase posting/read-back can exceed the 45-second heartbeat window;
    // without this touch the UI incorrectly changes to "Tally unavailable"
    // immediately after receiving a valid result.
    const { error: connectionTouchError } = await supabase
      .from("tally_connections")
      .update({
        last_heartbeat_at: now,
        updated_at: now,
      })
      .eq("id", connection.id)
      .is("revoked_at", null);
    if (connectionTouchError) throw connectionTouchError;

    const command = {
      ...pendingCommand,
      status: success ? "succeeded" : "failed",
      payload: commandPayload,
      result: isPurchaseVoucher ? compactPurchaseResult(result) : result,
      error: errorMessage,
      completed_at: now,
      agent_receipt: toNullableText(body.agentReceipt, 500),
      external_result_reference: toNullableText(body.externalResultReference, 1000),
    } as TallyBridgeCommandRow;

    if (command.command_type === "sync_masters") {
      await releaseTallyMasterSyncLock({
        supabase,
        connectionId: connection.id,
        token: typeof commandPayload.syncLockToken === "string" ? commandPayload.syncLockToken : null,
      });
    }

    if (success && command.command_type === "alter_ledger") {
      const masterKey = toNullableText(commandPayload.masterKey, 500);
      const newName = toNullableText(commandPayload.newName, 500);

      if (masterKey && newName) {
        await supabase
          .from("tally_masters")
          .update({
            tally_name: newName,
            raw_payload: {
              ...commandPayload,
              updatedFromCommandId: commandId,
              updatedFromCommandAt: now,
            },
          })
          .eq("connection_id", connection.id)
          .eq("owner_user_id", connection.owner_user_id)
          .eq("company_name", toNullableText(commandPayload.companyName, 240) ?? connection.last_company_name ?? "Unknown company")
          .eq("master_key", masterKey);
      }
    }

    if (success && command.command_type === "create_ledger") {
      const name = toNullableText(commandPayload.name, 500);
      const parentName = toNullableText(commandPayload.parentName, 240);

      if (name && parentName) {
        await supabase.from("tally_masters").upsert(
          {
            connection_id: connection.id,
            owner_user_id: connection.owner_user_id,
            company_name: toNullableText(commandPayload.companyName, 240) ?? connection.last_company_name ?? "Unknown company",
            sync_run_id: null,
            master_type: "ledger",
            master_key: normalizeMasterKey({ masterType: "ledger", name }),
            tally_guid: null,
            tally_name: name,
            parent_name: parentName,
            raw_payload: {
              createdFromCommandId: commandId,
              createdFromCommandAt: now,
              result,
            },
            is_active: true,
            last_synced_at: now,
          },
          {
            onConflict: "connection_id,company_name,master_type,master_key",
          }
        );
      }
    }

    /* Legacy bank completion is intentionally excluded from Bhuleshwar.
    if (command.command_type === "post_bank_voucher") {
      const transactionId = toNullableText(commandPayload.transactionId, 80);
      const bankAccountId = toNullableText(commandPayload.bankAccountId, 80);
      const fingerprint = toNullableText(commandPayload.fingerprint, 500);
      const voucherId =
        toNullableText((result as Record<string, unknown>).voucherId, 500) ??
        toNullableText((result as Record<string, unknown>).masterId, 500) ??
        commandId;
      const possibleDuplicateInTally = Boolean((result as Record<string, unknown>).possibleDuplicateInTally);
      const nextStatus = success ? "posted" : possibleDuplicateInTally ? "needs_tally_review" : "failed";

      if (transactionId) {
        const { error: transactionUpdateError } = await supabase
          .from("bank_transactions")
          .update({
            tally_status: nextStatus,
            tally_posted_at: success ? now : null,
            tally_voucher_id: success ? voucherId : null,
          })
          .eq("id", transactionId)
          .eq("owner_user_id", connection.owner_user_id);

        if (transactionUpdateError) throw transactionUpdateError;
      }

      if (bankAccountId && fingerprint) {
        const { error: postingLogError } = await supabase
          .from("bank_transaction_posting_log")
          .upsert(
            {
              owner_user_id: connection.owner_user_id,
              bank_account_id: bankAccountId,
              connection_id: connection.id,
              source_transaction_id: transactionId,
              fingerprint,
              transaction_date: toNullableText(commandPayload.voucherDate, 20) ?? now.slice(0, 10),
              reference_number: toNullableText(commandPayload.referenceNumber, 500),
              description: toNullableText(commandPayload.narration, 2000) ?? "Bank transaction",
              amount:
                typeof commandPayload.amount === "number"
                  ? commandPayload.amount
                  : Number(commandPayload.amount ?? 0) || null,
              voucher_type: toNullableText(commandPayload.voucherType, 80),
              bank_ledger_name: toNullableText(commandPayload.bankLedgerName, 500),
              counterparty_ledger_name: toNullableText(commandPayload.counterpartyLedgerName, 500),
              command_id: commandId,
              status: nextStatus,
              tally_voucher_id: success ? voucherId : null,
              tally_posted_at: success ? now : null,
              error: errorMessage,
              result,
            },
            {
              onConflict: "owner_user_id,bank_account_id,fingerprint",
            }
          );

        if (postingLogError) throw postingLogError;
      }

    }

    }
    */

    if (command.command_type === "create_purchase_voucher") {
      const postingId = toNullableText(commandPayload.postingId, 80);
      const verification = result.verification && typeof result.verification === "object"
        ? result.verification as Record<string, unknown>
        : result;
      const verificationStatus =
        toNullableText(verification.verificationStatus, 80) ??
        toNullableText(result.uncertaintyReason, 80);
      const alreadyInTally = success && Boolean(result.alreadyInTally);
      const verifiedAbsent = result.verifiedAbsent === true || result.voucherCreated === false;
      const verified = success && (verificationStatus === "verified" || alreadyInTally);
      const correctionRequired = Boolean(
        result.voucherCreatedButVerificationFailed ||
        result.uncertainWrite ||
        result.possibleDuplicateInTally ||
        verificationStatus === "mismatch" ||
        verificationStatus === "ambiguous"
      );
      const postingStatus = verified
        ? "created"
        : commandPayload.verificationOnly === true && success && verificationStatus === "missing"
          ? "ready_for_approval"
        : correctionRequired
          ? "verification_required"
          : "failed";
      const voucherNumber = verifiedAbsent
        ? null
        : toNullableText(verification.voucherNumber, 500) ??
          toNullableText(result.voucherNumber, 500);
      const masterId = verifiedAbsent
        ? null
        : positiveTallyId(verification.masterId) ??
          positiveTallyId(verification.voucherId) ??
          positiveTallyId(result.lastVchId);
      const tallyGuid = verifiedAbsent
        ? null
        : toNullableText(verification.guid, 500) ??
          toNullableText(result.guid, 500);
      const voucherWasCreated = !verifiedAbsent && (verified || Boolean(
        result.voucherCreatedButVerificationFailed ||
        Number(result.created ?? 0) > 0 ||
        voucherNumber ||
        masterId
      ));

      if (postingId) {
        const { error: postingUpdateError } = await supabase
          .from("purchase_invoice_tally_postings")
          .update({
            status: postingStatus,
            command_id: postingStatus === "ready_for_approval" ? null : commandId,
            tally_voucher_number: voucherNumber,
            tally_master_id: masterId,
            tally_guid: tallyGuid,
            tally_created_at: postingStatus === "ready_for_approval"
              ? null
              : voucherWasCreated && !alreadyInTally ? now : null,
            verified_at: verified ? now : null,
            verification_status: alreadyInTally ? "already_in_tally" : verificationStatus,
            last_error: verified ? null : purchaseVerificationError(errorMessage, verification),
          })
          .eq("id", postingId)
          .eq("owner_user_id", connection.owner_user_id)
          .eq("command_id", commandId);
        if (postingUpdateError) throw postingUpdateError;
      }
    }

    if (command.command_type === "verify_bank_transaction") {
      const transactionId = toNullableText(commandPayload.transactionId, 80);
      const bankAccountId = toNullableText(commandPayload.bankAccountId, 80);
      const fingerprint = toNullableText(commandPayload.fingerprint, 500);
      const verificationStatus =
        toNullableText((result as Record<string, unknown>).verificationStatus, 80) ??
        (success ? "missing" : "failed");
      const matched =
        success &&
        (verificationStatus === "found" ||
          verificationStatus === "matched" ||
          verificationStatus === "verified");
      const ambiguous = success && verificationStatus === "ambiguous";
      const nextStatus = matched
        ? "verified"
        : ambiguous
          ? "needs_tally_review"
          : success
            ? "missing_in_tally"
            : "verification_failed";
      const voucherId =
        toNullableText((result as Record<string, unknown>).voucherId, 500) ??
        toNullableText((result as Record<string, unknown>).masterId, 500) ??
        toNullableText((result as Record<string, unknown>).voucherNumber, 500);

      if (transactionId) {
        const { error: transactionUpdateError } = await supabase
          .from("bank_transactions")
          .update({
            tally_status: nextStatus,
            tally_posted_at: matched ? now : null,
            tally_voucher_id: matched ? voucherId : null,
          })
          .eq("id", transactionId)
          .eq("owner_user_id", connection.owner_user_id);

        if (transactionUpdateError) throw transactionUpdateError;
      }

      if (bankAccountId && fingerprint) {
        const { error: postingLogError } = await supabase
          .from("bank_transaction_posting_log")
          .upsert(
            {
              owner_user_id: connection.owner_user_id,
              bank_account_id: bankAccountId,
              connection_id: connection.id,
              source_transaction_id: transactionId,
              fingerprint,
              transaction_date: toNullableText(commandPayload.voucherDate, 20) ?? now.slice(0, 10),
              reference_number: toNullableText(commandPayload.referenceNumber, 500),
              description: toNullableText(commandPayload.narration, 2000) ?? "Bank transaction verification",
              amount:
                typeof commandPayload.amount === "number"
                  ? commandPayload.amount
                  : Number(commandPayload.amount ?? 0) || null,
              voucher_type: "Payment",
              bank_ledger_name: toNullableText(commandPayload.bankLedgerName, 500),
              counterparty_ledger_name: toNullableText(commandPayload.counterpartyLedgerName, 500),
              command_id: commandId,
              status: nextStatus,
              tally_voucher_id: matched ? voucherId : null,
              tally_posted_at: matched ? now : null,
              error: errorMessage,
              result,
            },
            {
              onConflict: "owner_user_id,bank_account_id,fingerprint",
            }
          );

        if (postingLogError) throw postingLogError;
      }
    }

    /* Legacy debit-note completion/PDF handling is intentionally excluded from Bhuleshwar.
    const isNativeDebitNotePdfExport =
      command.command_type === "export_debit_note_pdf" ||
      (command.command_type === "create_debit_note" && commandPayload.operation === "export_native_pdf");

    if (command.command_type === "create_debit_note" && !isNativeDebitNotePdfExport) {
      const proposalId = toNullableText(commandPayload.proposalId, 80);
      const voucherId =
        toNullableText((result as Record<string, unknown>).voucherId, 500) ??
        toNullableText((result as Record<string, unknown>).masterId, 500) ??
        commandId;
      const voucherGuid =
        toNullableText((result as Record<string, unknown>).voucherGuid, 500) ??
        toNullableText((result as Record<string, unknown>).guid, 500);
      const voucherNumber =
        toNullableText((result as Record<string, unknown>).voucherNumber, 500) ??
        toNullableText(commandPayload.referenceNumber, 500) ??
        voucherId;
      const openReferenceName =
        toNullableText((result as Record<string, unknown>).openReferenceName, 500) ??
        toNullableText(commandPayload.referenceNumber, 500) ??
        voucherNumber;
      const voucherDate =
        toNullableText((result as Record<string, unknown>).voucherDate, 20) ??
        toNullableText(commandPayload.voucherDate, 20);
      const amount =
        typeof commandPayload.amount === "number"
          ? commandPayload.amount
          : Number(commandPayload.amount ?? 0) || null;

      if (proposalId) {
        const { error: proposalUpdateError } = await supabase
          .from("debit_note_proposals")
          .update({
            status: success ? "created_in_tally" : "failed",
            tally_voucher_guid: success ? voucherGuid : null,
            tally_voucher_id: success ? voucherId : null,
            tally_voucher_number: success ? voucherNumber : null,
            tally_voucher_date: success ? voucherDate : null,
            tally_open_reference_name: success ? openReferenceName : null,
            remaining_recoverable_amount: success ? amount : null,
            created_in_tally_at: success ? now : null,
            last_synced_from_tally_at: success ? now : null,
            last_error: success ? null : errorMessage,
            updated_at: now,
          })
          .eq("id", proposalId)
          .eq("owner_user_id", connection.owner_user_id);

        if (proposalUpdateError) throw proposalUpdateError;

        // A document must be a native Tally export. The previous implementation
        // generated an application PDF here, which could not prove what was
        // actually posted in Tally and is deliberately no longer used.
      } else if (success && commandPayload.sourceProposal && typeof commandPayload.sourceProposal === "object") {
        const sourceProposal = commandPayload.sourceProposal as Record<string, unknown>;
        const { error: insertProposalError } = await supabase
          .from("debit_note_proposals")
          .insert({
            owner_user_id: connection.owner_user_id,
            connection_id: connection.id,
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
            original_invoice_amount: Number(sourceProposal.originalInvoiceAmount ?? 0) || null,
            cash_discount_rule_id: toNullableText(sourceProposal.cashDiscountRuleId, 80),
            cash_discount_rule_name: toNullableText(sourceProposal.cashDiscountRuleName, 160),
            discount_deadline: toNullableText(sourceProposal.discountDeadline, 20),
            receipt_date: toNullableText(sourceProposal.receiptDate, 20),
            amount_received: Number(sourceProposal.amountReceived ?? 0) || null,
            recoverable_amount: amount ?? 0,
            reason_code: toNullableText(commandPayload.reasonCode, 80) ?? "cash_discount_expired",
            narration: toNullableText(commandPayload.narration, 1000),
            gst_mode: toNullableText(commandPayload.gstMode, 80) ?? "finance_review",
            debit_note_date: voucherDate ?? now.slice(0, 10),
            status: "created_in_tally",
            approval_by: connection.owner_user_id,
            approved_at: now,
            tally_command_id: commandId,
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
          });

        if (insertProposalError) {
          if (insertProposalError.code !== '23505') throw insertProposalError;
          const {data: saved,error: savedError} = await supabase.from('debit_note_proposals')
            .select('tally_voucher_id,tally_voucher_guid,recoverable_amount').eq('tally_command_id',commandId)
            .eq('owner_user_id',connection.owner_user_id).maybeSingle();
          if (savedError) throw savedError;
          if (!saved || Number(saved.recoverable_amount) !== Number(amount) ||
            (voucherGuid ? saved.tally_voucher_guid !== voucherGuid : saved.tally_voucher_id !== voucherId)) throw insertProposalError;
        }

      }
    }

    if (isNativeDebitNotePdfExport) {
      const proposalId = toNullableText(commandPayload.proposalId, 80);
      const failNativePdfExport = async (message: string) => {
        await supabase
          .from("tally_bridge_commands")
          .update({ status: "failed", error: message, completed_at: new Date().toISOString() })
          .eq("id", commandId)
          .eq("connection_id", connection.id);
        if (proposalId) {
          await supabase
            .from("debit_note_proposals")
            .update({ last_error: message, updated_at: new Date().toISOString() })
            .eq("id", proposalId)
            .eq("owner_user_id", connection.owner_user_id);
        }
      };

      if (!success) {
        if (proposalId) {
          await supabase
            .from("debit_note_proposals")
            .update({ last_error: errorMessage ?? "Native Tally PDF export failed.", updated_at: new Date().toISOString() })
            .eq("id", proposalId)
            .eq("owner_user_id", connection.owner_user_id);
        }
      } else {
        try {
        if (!proposalId) throw new Error("Native Tally PDF export is missing its debit note proposal.");
        if (!nativePdfBase64) throw new Error("The connector completed the export without returning a native Tally PDF.");

        const pdf = Buffer.from(nativePdfBase64, "base64");
        if (pdf.length === 0 || !pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
          throw new Error("The connector returned an invalid native Tally PDF.");
        }
        const { data: proposalData, error: proposalError } = await supabase
          .from("debit_note_proposals")
          .select("*")
          .eq("id", proposalId)
          .eq("owner_user_id", connection.owner_user_id)
          .maybeSingle();
        if (proposalError) throw proposalError;
        if (!proposalData) throw new Error("Debit note proposal was not found while attaching the native Tally PDF.");

        const proposal = proposalData as unknown as DebitNoteProposalRow;
        const voucherId = toNullableText(result.voucherId, 500);
        const voucherNumber = toNullableText(result.voucherNumber, 500);
        const voucherType = toNullableText(result.voucherType, 120);
        const reference = toNullableText(result.voucherReference, 500) ?? toNullableText(result.openReferenceName, 500);
        const partyLedgerName = toNullableText(result.partyLedgerName, 500);
        const requestedReference = proposal.tally_open_reference_name || proposal.tally_voucher_number;

        if (!voucherId || !voucherNumber || voucherType?.toLowerCase() !== "debit note") {
          throw new Error("Tally did not verify an identifiable Debit Note before exporting its PDF.");
        }
        // Older debit notes stored their Kalika reference in tally_voucher_id.
        // Treat only a numeric Tally MasterID as a previously verified identity;
        // an older non-numeric value is repaired after the reference check below.
        const existingVoucherId = proposal.tally_voucher_id?.trim();
        if (existingVoucherId && /^\d+$/.test(existingVoucherId) && existingVoucherId !== voucherId.trim()) {
          throw new Error("The exported Tally PDF belongs to a different Debit Note than the one created by Bhuleshwar.");
        }
        if (requestedReference && (!reference || requestedReference.trim().toLowerCase() !== reference.trim().toLowerCase())) {
          throw new Error("The exported Tally PDF reference does not match the selected Debit Note.");
        }
        if (!partyLedgerName || partyLedgerName.trim().toLowerCase() !== proposal.party_ledger_name.trim().toLowerCase()) {
          throw new Error("The exported Tally PDF customer does not match the selected Debit Note.");
        }
        if (Math.abs(toNumber(result.amount) - toNumber(proposal.recoverable_amount)) > 0.01) {
          throw new Error("The exported Tally PDF amount does not match the selected Debit Note.");
        }

        const uploaded = await uploadNativeTallyDebitNotePdf(
          supabase as unknown as Parameters<typeof uploadNativeTallyDebitNotePdf>[0],
          proposal,
          pdf
        );
        const connectorHash = toNullableText(result.nativePdfSha256, 128);
        if (connectorHash && connectorHash.toLowerCase() !== uploaded.sha256.toLowerCase()) {
          throw new Error("The native Tally PDF changed before it reached Bhuleshwar. Export was rejected.");
        }
        const nowForPdf = new Date().toISOString();
        const snapshot = proposal.customer_snapshot && typeof proposal.customer_snapshot === "object"
          ? proposal.customer_snapshot
          : {};
        const { error: proposalUpdateError } = await supabase
          .from("debit_note_proposals")
          .update({
            tally_voucher_id: voucherId,
            tally_voucher_guid: toNullableText(result.voucherGuid, 500) ?? proposal.tally_voucher_guid,
            tally_voucher_number: voucherNumber,
            tally_voucher_date: toNullableText(result.voucherDate, 20) ?? proposal.tally_voucher_date,
            tally_open_reference_name: reference ?? requestedReference,
            tally_pdf_reference: uploaded.reference,
            customer_snapshot: {
              ...snapshot,
              nativeTallyPdf: {
                source: "tally_voucher_render",
                status: "verified",
                voucherId,
                voucherNumber,
                reference: reference ?? null,
                alterId: toNullableText(result.voucherAlterId, 500),
                sha256: uploaded.sha256,
                byteSize: uploaded.byteSize,
                exportedAt: nowForPdf,
              },
            },
            last_error: null,
            updated_at: nowForPdf,
          })
          .eq("id", proposal.id)
          .eq("owner_user_id", connection.owner_user_id);
        if (proposalUpdateError) throw proposalUpdateError;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Native Tally PDF export could not be verified.";
          await failNativePdfExport(message);
          throw error;
        }
      }
    }

    */

    await supabase.from("tally_connection_events").insert({
      connection_id: connection.id,
      owner_user_id: connection.owner_user_id,
      event_type: success ? "command_succeeded" : "command_failed",
      message: success ? "Tally command completed." : "Tally command failed.",
      payload: {
        commandId,
        commandType: command.command_type,
        error: errorMessage,
      },
    });

    return jsonWithCors(request, {
      command: serializeTallyBridgeCommand(command),
    });
  } catch (error) {
    const accessFailure = accessFailureResponse(request, error);
    if (accessFailure) return accessFailure;
    console.error("Error in POST /api/tally/bridge/commands/[commandId]/result:", error);
    return jsonWithCors(
      request,
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
