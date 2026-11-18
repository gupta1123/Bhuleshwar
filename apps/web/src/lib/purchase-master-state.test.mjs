import test from 'node:test';
import assert from 'node:assert/strict';
import {purchaseMasterReadiness} from './purchase-master-state.ts';
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
