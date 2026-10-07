import test from 'node:test';
import assert from 'node:assert/strict';
import {companyOptionIdentity} from './company-option-identity.ts';
test('company labels cannot collapse separate PCs, companies or financial years',()=>{
 const base={id:'dataset-a',connectionId:'pc-a',accessCompanyId:'company-a',financialYear:'2026-27',companyName:'Same name'};
 const inputs=[base,{...base,connectionId:'pc-b'},{...base,accessCompanyId:'company-b'},{...base,financialYear:'2025-26'}];
 assert.equal(new Set(inputs.map(companyOptionIdentity)).size,4);
 assert.equal(companyOptionIdentity(base),companyOptionIdentity({...base,companyName:'Renamed'}));
 assert.notEqual(companyOptionIdentity({...base,accessCompanyId:undefined}),companyOptionIdentity({...base,accessCompanyId:undefined,id:'dataset-b'}));
});
