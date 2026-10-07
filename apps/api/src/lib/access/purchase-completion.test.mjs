import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const exports={};
const code=ts.transpileModule(await readFile(new URL('./purchase-completion.ts',import.meta.url),'utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
vm.runInNewContext(code,{exports,require:()=>({AccessError:class extends Error{}})});
const {purchaseCompletion,completeTeamPurchase}=exports;
test('transport success alone never marks a purchase posted',()=>{
 for(const result of [{},{created:1},{verification:{verificationStatus:'mismatch'}},{possibleDuplicateInTally:true}]){
  const outcome=purchaseCompletion(true,result,null);assert.equal(outcome.verified,false);assert.ok(outcome.error);
 }
 assert.equal(purchaseCompletion(false,{verification:{verificationStatus:'verified'}},'failed').verified,false);
});
test('verified and already-existing vouchers preserve verification information',()=>{
 const result=purchaseCompletion(true,{verification:{verificationStatus:'verified',masterId:'123',voucherNumber:'P-9',guid:'guid'}},null);
 assert.equal(result.verified,true);assert.equal(result.masterId,'123');assert.equal(result.voucherNumber,'P-9');
 assert.equal(purchaseCompletion(true,{alreadyInTally:true},null).verificationStatus,'already_in_tally');
 assert.equal(purchaseCompletion(true,{lastVchId:0},null).masterId,null);
});
test('verified-absent failures never preserve a stale Tally master id',()=>{
 const result=purchaseCompletion(false,{verifiedAbsent:true,voucherCreated:false,lastVchId:'140111',voucherNumber:'1'},'rejected');
 assert.equal(result.verified,false);assert.equal(result.voucherCreated,false);
 assert.equal(result.masterId,null);assert.equal(result.voucherNumber,null);assert.equal(result.guid,null);
});
test('completion uses one atomic RPC and propagates a persistence conflict',async()=>{
 const calls=[];const input={commandId:'cmd',connectionId:'conn',bridgeTokenHash:'hash',success:true,
  result:{verification:{verificationStatus:'verified'}},compactResult:{verificationStatus:'verified'},error:null,
  db:{rpc:async(name,args)=>{calls.push({name,args});return {data:{id:'cmd'}};}}};
 const result=await completeTeamPurchase(input);assert.equal(result.id,'cmd');assert.equal(calls.length,1);
 assert.equal(calls[0].name,'access_complete_purchase_command');assert.equal(calls[0].args.p_result.verified,true);
 const conflict={code:'40001'};
 await assert.rejects(completeTeamPurchase({...input,db:{rpc:async()=>({error:conflict})}}),error=>error===conflict);
});
