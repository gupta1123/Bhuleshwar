import test from 'node:test';
import assert from 'node:assert/strict';
import {runDebitNoteBatch} from './bulk-debit-notes.ts';
test('posts sequentially and confirms each result',async()=>{
 const seen=[];let active=0;
 const result=await runDebitNoteBatch([1,2,3],{canContinue:()=>true,create:async row=>{assert.equal(active++,0);await Promise.resolve();active--;seen.push(row);},confirmed:row=>seen.push(`ok${row}`),uncertain:()=>assert.fail()});
 assert.deepEqual(seen,[1,'ok1',2,'ok2',3,'ok3']);assert.equal(result.confirmed,3);assert.equal(result.stopped,false);
});
test('uncertain write stops the batch without retry or attempting later notes',async()=>{
 const tried=[],confirmed=[],uncertain=[];
 const result=await runDebitNoteBatch([1,2,3],{canContinue:()=>true,create:async row=>{tried.push(row);if(row===2)throw Error('response lost');},confirmed:row=>confirmed.push(row),uncertain:row=>uncertain.push(row)});
 assert.deepEqual(tried,[1,2]);assert.deepEqual(confirmed,[1]);assert.deepEqual(uncertain,[2]);assert.equal(result.stopped,true);
});
test('scope change stops unstarted entries while preserving issued result',async()=>{
 let valid=true;const confirmed=[];
 const result=await runDebitNoteBatch([1,2],{canContinue:()=>valid,create:async()=>{valid=false;},confirmed:row=>confirmed.push(row),uncertain:()=>assert.fail()});
 assert.deepEqual(confirmed,[1]);assert.equal(result.scopeChanged,true);
});
