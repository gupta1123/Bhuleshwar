import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionsAccessReady as ready } from './collections-access-ready.ts';

test('startup waits for access even before enforcement is discovered', () => {
  assert.equal(ready({loading:true,error:null,enforcementRequired:false,snapshot:null}), false);
});
test('revoked or unverified access never starts a company check', () => {
  assert.equal(ready({loading:false,error:null,enforcementRequired:true,snapshot:null}), false);
  assert.equal(ready({loading:false,error:'Cannot verify',enforcementRequired:false,snapshot:null}), false);
});
test('verified access resumes while supported legacy mode remains usable', () => {
  assert.equal(ready({loading:false,error:null,enforcementRequired:true,snapshot:{revision:2}}), true);
  assert.equal(ready({loading:false,error:null,enforcementRequired:false,snapshot:null}), true);
});
