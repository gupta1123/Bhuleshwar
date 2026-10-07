import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CASE_LIST_COLUMNS,CASE_LIST_META_KEYS,restoreCaseListMetadata,makeCaseCursor,readCaseCursor,cursorPredicate,missingCaseColumn} from './case-list-query.ts';
const row={id:'12345678-1234-1234-1234-123456789abc',created_at:'2026-09-04T12:00:00Z',deleted_at:'2026-09-05T12:00:00Z',display_name:'A, ("B")'};
test('directory projection excludes full processing metadata and preserves presentation inputs',()=>{
  assert.ok(!CASE_LIST_COLUMNS.split(',').includes('processing_meta'));
  const meta={caseCategory:'Goods',packetCategory:'Other',documentTypes:['invoice'],termsComplianceMismatchMode:'old',termsComplianceChecklist:[{status:'unknown',severity:'high'}],recycleBin:{deletedAt:row.deleted_at}};
  const projected={...row,...Object.fromEntries(CASE_LIST_META_KEYS.map(k=>[`list_${k}`,meta[k]]))};
  assert.deepEqual(restoreCaseListMetadata(projected).processing_meta,meta);
  assert.deepEqual(restoreCaseListMetadata({...row,processing_meta:meta}).processing_meta,meta);
});
test('cursors honor every sort and stable ID tie-breaker',()=>{
  for(const sort of ['recent','oldest','name']) {
    const c=readCaseCursor(makeCaseCursor(row,'active',sort),'active',sort);
    const filter=cursorPredicate(c,'active',sort);
    assert.match(filter,sort==='recent'?/^created_at.lt/:sort==='oldest'?/^created_at.gt/:/^display_name.gt/);
    assert.ok(filter.includes(`id.${sort==='name'?'gt':'lt'}.${row.id}`));
  }
  assert.match(cursorPredicate(readCaseCursor(makeCaseCursor(row,'deleted','recent'),'deleted','recent'),'deleted','recent'),/^deleted_at.lt/);
});
test('rejects malformed, mismatched and oversized cursor inputs',()=>{
  assert.throws(()=>readCaseCursor('bogus','active','recent'));
  assert.throws(()=>readCaseCursor(makeCaseCursor(row,'active','name'),'active','recent'));
  assert.throws(()=>readCaseCursor(makeCaseCursor(row,'deleted','recent'),'active','recent'));
  assert.throws(()=>readCaseCursor('a'.repeat(5000),'active','recent'));
  const inject=Buffer.from(JSON.stringify({...row,sortValue:row.created_at,id:'x),owner_user_id.neq.x'})).toString('base64url');
  assert.throws(()=>readCaseCursor(inject,'active','recent'));
});
test('does not classify network/auth/query errors as missing search schema',()=>{
  assert.equal(missingCaseColumn({code:'42703',message:'column search_text does not exist'},'search_text'),true);
  assert.equal(missingCaseColumn({code:'PGRST204',message:'missing search_text'},'search_text'),true);
  assert.equal(missingCaseColumn({code:'PGRST301',message:'search_text not authorized'},'search_text'),false);
  assert.equal(missingCaseColumn({code:'42703',message:'column deleted_at does not exist'},'search_text'),false);
});
