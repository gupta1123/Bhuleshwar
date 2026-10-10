import test from 'node:test';
import assert from 'node:assert/strict';
import {readCompleteHistory} from './collections-history.ts';

test('history reads beyond the former 100/500/1000 row caps',async()=>{
  const values=Array.from({length:1207},(_,id)=>({id}));const calls=[];
  const result=await readCompleteHistory(async(from,to)=>{calls.push([from,to]);return {data:values.slice(from,to+1),error:null};});
  assert.deepEqual(result,values);assert.equal(calls.length,3);
});
test('history fails closed instead of returning incomplete accounting evidence',async()=>{
  await assert.rejects(readCompleteHistory(async()=>({data:null,error:new Error('database unavailable')})),/database unavailable/);
});
