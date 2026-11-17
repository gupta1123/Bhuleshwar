import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchWithReadRetry} from './api-read-retry.ts';

test('a transient read failure recovers and preserves the successful response',async()=>{
 let calls=0;
 const response=await fetchWithReadRetry(async()=>++calls===1?new Response('Unavailable',{status:503}):new Response('Ready'));
 assert.equal(calls,2);assert.equal(await response.text(),'Ready');
});

test('mutations and aborted reads are never replayed',async()=>{
 for(const method of ['POST','PATCH','PUT','DELETE']){
  let calls=0;const response=await fetchWithReadRetry(async()=>{calls++;return new Response('',{status:503});},{method});
  assert.equal(calls,1);assert.equal(response.status,503);
 }
 const controller=new AbortController();let calls=0;
 await assert.rejects(fetchWithReadRetry(async()=>{calls++;controller.abort();throw controller.signal.reason;},{signal:controller.signal}),{name:'AbortError'});
 assert.equal(calls,1);
});

test('a changed access scope prevents replay of the old request',async()=>{
 let calls=0;
 const response=await fetchWithReadRetry(async()=>{calls++;return new Response('',{status:503});},undefined,()=>false);
 assert.equal(calls,1);assert.equal(response.status,503);
});
