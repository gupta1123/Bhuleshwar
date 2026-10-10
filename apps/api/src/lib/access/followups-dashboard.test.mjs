import test from 'node:test';
import assert from 'node:assert/strict';
import {followUpsDashboard} from './followups-dashboard.ts';
import {LIVE_OPERATION_PERMISSIONS} from './live-policy.ts';
import {userRoutePolicy} from './route-policy.ts';

test('follow-ups has independent read and preparation authority', () => {
  assert.deepEqual(userRoutePolicy('/api/collections/follow-ups','GET').permissions,['followups.view']);
  assert.deepEqual(userRoutePolicy('/api/collections/follow-ups/analyse','POST').permissions,['followups.prepare']);
  assert.deepEqual(LIVE_OPERATION_PERMISSIONS.followups_scan,['followups.prepare']);
  assert.deepEqual(LIVE_OPERATION_PERMISSIONS.scan,['discounts.prepare']);
});
test('follow-up response omits discount history, amounts, narration and arbitrary fields', () => {
  const rows = [{partyLedgerName:'Customer',outstandingAmount:10}];
  const projected=followUpsDashboard({company:{companyName:'Verified'},secret:'excluded',
    kpis:{paymentFollowUps:1,createdDebitNoteAmount:500},narrationAnalysis:{secret:true},
    tabs:{paymentFollowUps:rows,debitNoteQueue:[{secret:true}],cashDiscountTracker:[{secret:true}]}});
  assert.equal(projected.tabs.paymentFollowUps,rows);
  assert.deepEqual(projected.tabs.debitNoteQueue,[]);
  assert.equal(projected.kpis.createdDebitNoteAmount,undefined);
  assert.equal(projected.secret,undefined); assert.equal(projected.narrationAnalysis,undefined);
});
