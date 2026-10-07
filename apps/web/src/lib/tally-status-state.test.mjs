import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deriveTallyIndicator,heartbeatAge} from './tally-status-state.ts';
const connection={id:'client',bridgeConnected:true,tallyReachable:true,companyLoaded:true,lastCompanyName:'Client Company',
  lastHeartbeatAt:'2026-09-04T10:00:00Z',lastTestedAt:'2026-09-04T10:00:00Z'};
test('fresh selected company remains connected; route navigation does not affect the state',()=>{
  assert.deepEqual(deriveTallyIndicator([connection],{connectionId:'client'},1000,1000,true),{status:'connected',companyName:'Client Company'});
});
test('never falls back to another PC, including ambiguous unselected connections',()=>{
  assert.equal(deriveTallyIndicator([connection],{connectionId:'missing'},0,0,true).status,'disconnected');
  assert.equal(deriveTallyIndicator([connection,{...connection,id:'admin'}],{connectionId:null},0,0,true).status,'disconnected');
});
test('heartbeat expiry, network loss and outdated observations never remain connected',()=>{
  for(const [age,heartbeat,online] of [[45001,0,true],[0,45001,true],[0,0,false]])
    assert.equal(deriveTallyIndicator([connection],{connectionId:'client'},age,heartbeat,online).status,'unavailable');
});
test('wrong company, unreadable Tally and disconnected agent have distinct states',()=>{
  assert.equal(deriveTallyIndicator([connection],{connectionId:'client',companyName:'Other'},0,0,true).status,'attention');
  assert.equal(deriveTallyIndicator([{...connection,tallyReachable:false}],{connectionId:'client'},0,0,true).status,'attention');
  assert.equal(deriveTallyIndicator([{...connection,bridgeConnected:false}],{connectionId:'client'},0,0,true).status,'disconnected');
});
test('heartbeat age uses server clock and fails closed when timestamps are missing',()=>{
  assert.equal(heartbeatAge(connection,Date.parse('2026-09-04T10:00:30Z')),30000);
  assert.equal(heartbeatAge({...connection,lastTestedAt:null},Date.now()),Infinity);
});
