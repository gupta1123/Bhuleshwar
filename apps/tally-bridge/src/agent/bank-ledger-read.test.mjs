import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTallyMasters } from '../bridge.mjs';

const identity = { ownerUserId: 'owner', organizationId: 'org', connectionId: 'connection', installationId: 'machine',
  sessionGeneration: 3, companyGuid: 'guid', companyName: 'Company', financialYear: '2026-2027' };
function mockTally(t, returnedGuid = 'guid') {
  const requests = []; let active = 0, maximum = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = String(options.body); requests.push(body); active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    const xml = body.includes('Company Profile Sync')
      ? `<ENVELOPE><COMPANY NAME="Company"><NAME>Company</NAME><GUID>${returnedGuid}</GUID><FINANCIALYEARFROM>20260401</FINANCIALYEARFROM></COMPANY></ENVELOPE>`
      : body.includes('Groups Sync') ? '<ENVELOPE><GROUP NAME="Debtors"><NAME>Debtors</NAME><GUID>group</GUID></GROUP></ENVELOPE>'
      : '<ENVELOPE><LEDGER NAME="Z Customer"><NAME>Z Customer</NAME><GUID>z</GUID><PARENT>Debtors</PARENT></LEDGER><LEDGER NAME="A Customer"><NAME>A Customer</NAME><GUID>a</GUID><PARENT>Debtors</PARENT></LEDGER></ENVELOPE>';
    return new Response(xml.replace('<ENVELOPE>', '<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER>'));
  });
  return { requests, maximum: () => maximum };
}
test('v2 fresh master request is serial, keeps catalogue ordering and validates its company profile', async t => {
  const tally = mockTally(t);
  const result = await collectTallyMasters({ ...identity, tallyUrl: 'http://localhost:9999' }, {
    companyName: 'Company', requestedMasterTypes: ['ledger','group'], bankDocumentIdentity: identity,
  });
  assert.equal(tally.maximum(), 1); assert.equal(tally.requests.length, 3);
  assert.deepEqual(result.ledgers.map(row => row.name), ['Z Customer','A Customer']);
  assert.equal(result.companyProfile.guid, 'guid');
});
test('same-name company with another GUID cannot supply document ledger context', async t => {
  mockTally(t, 'different-guid');
  await assert.rejects(collectTallyMasters({ ...identity, tallyUrl: 'http://localhost:9999' }, {
    companyName: 'Company', requestedMasterTypes: ['ledger','group'], bankDocumentIdentity: identity,
  }), { code: 'AGENT_IDENTITY_MISMATCH' });
});
