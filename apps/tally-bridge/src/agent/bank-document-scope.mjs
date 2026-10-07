import { normalizeFinancialYear } from './identity.mjs';

export function assertBankDocumentScope(config, supplied, companyProfile) {
  const expected = { ownerUserId: config.ownerUserId, organizationId: config.organizationId || config.ownerUserId,
    connectionId: config.connectionId, installationId: config.installationId || config.bridgeMachineId,
    sessionGeneration: config.sessionGeneration };
  for (const field of Object.keys(expected)) {
    if (expected[field] == null || !String(expected[field]) || String(expected[field]) !== String(supplied?.[field])) {
      throw Object.assign(new Error('The bank statement connection or pairing changed. Reselect the document.'), { code: 'AGENT_IDENTITY_MISMATCH' });
    }
  }
  if (!supplied.companyGuid || !supplied.companyName || !supplied.financialYear) throw new Error('Incomplete bank document company scope.');
  if (companyProfile && (companyProfile.guid !== supplied.companyGuid || companyProfile.name !== supplied.companyName ||
      normalizeFinancialYear(companyProfile.financialYear) !== normalizeFinancialYear(supplied.financialYear))) {
    throw Object.assign(new Error('Tally returned a different company or financial year. Ledger preparation was rejected.'), { code: 'AGENT_IDENTITY_MISMATCH' });
  }
  return supplied;
}
