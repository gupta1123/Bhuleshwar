import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBankDocumentScope } from './bank-document-scope.mjs';
const identity = { ownerUserId: 'owner', organizationId: 'org', connectionId: 'connection', installationId: 'machine',
  sessionGeneration: 3, companyGuid: 'guid', companyName: 'Company', financialYear: '2026-2027' };
const profile = { guid: 'guid', name: 'Company', financialYear: '2026-27' };
test('live bank ledger identity accepts the exact pairing and the returned Tally GUID/year', () => {
  assert.deepEqual(assertBankDocumentScope(identity, identity, profile), identity);
});
for (const field of ['ownerUserId','organizationId','connectionId','installationId','sessionGeneration']) {
  test(`live bank ledger identity rejects a different ${field}`, () => {
    assert.throws(() => assertBankDocumentScope(identity, { ...identity, [field]: 'different' }, profile), { code: 'AGENT_IDENTITY_MISMATCH' });
  });
}
test('a matching company display name cannot hide a different GUID or financial year', () => {
  for (const profileChange of [{ guid: 'restored-guid' }, { financialYear: '2025-26' }, { name: 'Another Company' }]) {
    assert.throws(() => assertBankDocumentScope(identity, identity, { ...profile, ...profileChange }), { code: 'AGENT_IDENTITY_MISMATCH' });
  }
});
