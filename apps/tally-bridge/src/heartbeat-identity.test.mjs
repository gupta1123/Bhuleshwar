import assert from 'node:assert/strict';
import test from 'node:test';
import {adoptHeartbeatIdentity} from './bridge.mjs';

const base={connectionId:'connection-a',installationId:'pc-a',sessionGeneration:4,organizationId:'default'};
const identity={connectionId:'connection-a',installationId:'pc-a',sessionGeneration:4,organizationId:'org-a',ownerUserId:'owner-a'};

test('authenticated heartbeat replaces only a legacy default organization',()=>{
  const config={...base};let saved=null;
  assert.equal(adoptHeartbeatIdentity(config,{agentIdentity:identity},value=>{saved={...value};}),true);
  assert.equal(config.organizationId,'org-a');assert.equal(config.ownerUserId,'owner-a');assert.equal(saved.organizationId,'org-a');
  assert.equal(adoptHeartbeatIdentity(config,{agentIdentity:identity},()=>assert.fail('unchanged identity must not be rewritten')),false);
});

test('heartbeat cannot move a scoped connector or cross installations',()=>{
  assert.throws(()=>adoptHeartbeatIdentity({...base,organizationId:'org-b'},{agentIdentity:identity},()=>{}),/different organization/i);
  assert.throws(()=>adoptHeartbeatIdentity({...base},{agentIdentity:{...identity,installationId:'pc-b'}},()=>{}),/different connector identity/i);
});
