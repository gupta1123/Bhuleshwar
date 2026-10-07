import { AccessError } from './server';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : null;
}
/** Classification is deliberately conservative after a write was issued. A
 * successful transport response is not proof of a verified accounting entry. */
export function purchaseCompletion(success: boolean, result: Record<string, unknown>, error: string | null) {
  const verification = result.verification && typeof result.verification === 'object'
    ? result.verification as Record<string, unknown> : result;
  const alreadyInTally = success && result.alreadyInTally === true;
  const verifiedAbsent = result.verifiedAbsent === true || result.voucherCreated === false;
  const uncertaintyReason = text(result.uncertaintyReason);
  const verificationStatus = text(verification.verificationStatus) || uncertaintyReason;
  const verified = success && (verificationStatus === 'verified' || alreadyInTally);
  const voucherNumber = verifiedAbsent ? null : text(verification.voucherNumber) || text(result.voucherNumber);
  const rawId = verification.masterId ?? verification.voucherId ?? result.lastVchId;
  const masterId = !verifiedAbsent && rawId !== undefined && rawId !== null && /^\d+$/.test(String(rawId)) && Number(rawId) > 0 ? String(rawId).slice(0, 500) : null;
  const guid = verifiedAbsent ? null : text(verification.guid) || text(result.guid);
  const differences = Array.isArray(verification.differences)
    ? verification.differences.filter((v): v is string => typeof v === 'string' && Boolean(v.trim())).slice(0, 5).map(v => v.trim().slice(0, 300)) : [];
  return {
    verified, alreadyInTally, voucherNumber, masterId, guid,
    uncertainWrite: result.uncertainWrite === true,
    uncertaintyReason,
    verificationStatus: alreadyInTally ? 'already_in_tally' : verificationStatus,
    voucherCreated: verifiedAbsent ? false : verified || result.voucherCreatedButVerificationFailed === true || Number(result.created || 0) > 0 || Boolean(voucherNumber || masterId),
    error: verified ? null : differences.length
      ? `Tally verification needs attention: ${differences.join(' ')}`.slice(0, 2000)
      : error?.slice(0, 2000) || 'The issued Tally write was not verified. Verify the existing voucher before retrying.',
  };
}

export async function completeTeamPurchase(input: {
  db: { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };
  commandId: string; connectionId: string; bridgeTokenHash: string;
  success: boolean; result: Record<string, unknown>; compactResult: Record<string, unknown>; error: string | null;
}) {
  const outcome = purchaseCompletion(input.success, input.result, input.error);
  const { data, error } = await input.db.rpc('access_complete_purchase_command', {
    p_command: input.commandId, p_connection: input.connectionId, p_token_hash: input.bridgeTokenHash,
    p_result: { ...outcome, compactResult: input.compactResult },
  });
  if (error) throw error;
  if (!data || typeof data !== 'object' || !('id' in data)) throw new AccessError('Could not record the purchase result.', 503);
  return data;
}
