import test from 'node:test';
import assert from 'node:assert/strict';
import {purchaseMasterReadiness,mayLoadPurchaseCatalogue} from './purchase-master-state.ts';
const idle={posted:false,initialLoading:false,refreshing:false,supplierMatching:false,lineMatching:false,ready:false};

test('a failed or skipped catalogue load is unavailable, not an endless validation',()=>{
 assert.deepEqual(purchaseMasterReadiness(idle),{checking:false,unavailable:true});
 assert.deepEqual(purchaseMasterReadiness({...idle,refreshing:true}),{checking:true,unavailable:false});
 assert.deepEqual(purchaseMasterReadiness({...idle,refreshing:false}),{checking:false,unavailable:true});
 assert.deepEqual(purchaseMasterReadiness({...idle,ready:true}),{checking:false,unavailable:false});
});

test('only active reads and matching operations keep validation pending',()=>{
 for(const field of ['initialLoading','refreshing','supplierMatching','lineMatching'])assert.deepEqual(purchaseMasterReadiness({...idle,ready:true,[field]:true}),{checking:true,unavailable:false});
 assert.deepEqual(purchaseMasterReadiness({...idle,posted:true,refreshing:true}),{checking:false,unavailable:false});
});

test('a verified first-time purchase draft loads ledgers and locked or unauthorised reviews do not',()=>{
  assert.equal(mayLoadPurchaseCatalogue(true,true,null,null),true);
  assert.equal(mayLoadPurchaseCatalogue(true,true,null,{state:"draft"}),true);
  assert.equal(mayLoadPurchaseCatalogue(true,false,null,null),false);
  assert.equal(mayLoadPurchaseCatalogue(true,true,"Approval unavailable",null),false);
  for(const state of ["awaiting_approval","approved","posting","posted"]) {
    assert.equal(mayLoadPurchaseCatalogue(true,true,null,{state}),false);
  }
});
