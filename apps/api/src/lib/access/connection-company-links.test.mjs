import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./connection-company-links.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
vm.runInNewContext(code, { exports, require: () => ({ createSupabaseAdminClient() { throw new Error('unused'); } }) });
const select = exports.selectRestorableCompanyLinks;
const chooseAutomaticCompanyTarget = exports.chooseAutomaticCompanyTarget;
const base = { organization_id: 'org', company_id: 'company-a', connection_id: 'old', installation_id: 'pc-a', company_guid: 'guid-a', financial_year: '2026-27', verified_at: '2026-09-01T00:00:00Z', evidence: 'owner-confirmed' };

test('restores exact installation identity onto a replacement session', () => {
  const result = select([base, { ...base, installation_id: 'pc-b', company_id: 'company-b' }], [], { organizationId: 'org', installationId: 'pc-a', connectionId: 'new', now: '2026-09-08T00:00:00Z' });
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].connection_id, 'new');
  assert.equal(result.links[0].company_id, 'company-a');
  assert.equal(result.conflicts.length, 0);
});

test('keeps financial years separate and never crosses organizations or PCs', () => {
  const result = select([
    base,
    { ...base, financial_year: '2025-26' },
    { ...base, organization_id: 'other', company_id: 'private' },
    { ...base, installation_id: 'pc-b', company_id: 'private' },
  ], [], { organizationId: 'org', installationId: 'pc-a', connectionId: 'new', now: '2026-09-08T00:00:00Z' });
  assert.equal(JSON.stringify(result.links.map((link) => link.financial_year).sort()), JSON.stringify(['2025-26', '2026-27']));
  assert.ok(result.links.every((link) => link.company_id === 'company-a'));
});

test('refuses conflicting company assignments for one stable Tally identity', () => {
  const result = select([base, { ...base, company_id: 'company-b', connection_id: 'other-old' }], [], { organizationId: 'org', installationId: 'pc-a', connectionId: 'new', now: '2026-09-08T00:00:00Z' });
  assert.equal(result.links.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(JSON.stringify([...result.conflicts[0].companyIds].sort()), JSON.stringify(['company-a', 'company-b']));
});

test('automatic company selection prefers the exact Tally identity', () => {
  const observed = { companyGuid: 'guid-a', companyName: 'Solution Nyx', financialYear: '2026-27', isActive: true };
  const result = chooseAutomaticCompanyTarget(observed, [
    { id: 'name-only', name: 'Solution Nyx', erp_identity: 'legacy-name' },
    { id: 'exact', name: 'Renamed company', erp_identity: 'tally-guid:guid-a:fy:2026-27' },
  ]);
  assert.equal(result.kind, 'existing');
  assert.equal(result.company.id, 'exact');
  assert.equal(result.evidence, 'automatic-exact-erp-identity');
});

test('automatic company selection accepts one normalized name and refuses ambiguity', () => {
  const observed = { companyGuid: 'guid-a', companyName: '  Solution   Nyx ', financialYear: '2026-27', isActive: true };
  const unique = chooseAutomaticCompanyTarget(observed, [{ id: 'company-a', name: 'solution nyx', erp_identity: 'legacy' }]);
  assert.equal(unique.kind, 'existing');
  assert.equal(unique.company.id, 'company-a');
  const ambiguous = chooseAutomaticCompanyTarget(observed, [
    { id: 'company-a', name: 'Solution Nyx', erp_identity: 'legacy-a' },
    { id: 'company-b', name: 'solution  nyx', erp_identity: 'legacy-b' },
  ]);
  assert.equal(ambiguous.kind, 'ambiguous');
});

test('automatic company selection creates a stable identity only when no company matches', () => {
  const result = chooseAutomaticCompanyTarget(
    { companyGuid: 'guid-a', companyName: 'New Company', financialYear: '2026-27', isActive: true },
    [{ id: 'other', name: 'Other Company', erp_identity: 'legacy' }],
  );
  assert.equal(result.kind, 'create');
  assert.equal(result.erpIdentity, 'tally-guid:guid-a:fy:2026-27');
});
