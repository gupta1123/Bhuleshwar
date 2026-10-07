import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFile} from 'node:fs/promises';import ts from 'typescript';
const source=await readFile(new URL('./cash-discount-live.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
test('organization switch during token lookup cannot open a live socket in the new organization',async()=>{
 let resolve,epoch=0,sockets=0,organization='org-a';const exports={};
 const pending=new Promise(r=>resolve=r);
 const imports={'@/lib/api-client':{getApiAccessToken:()=>pending},'@/lib/access-cache':{accessCacheEpoch:()=>epoch,registerAccessCache(){}}};
 vm.runInNewContext(code,{exports,require:name=>imports[name],DOMException,URL,
  process:{env:{NEXT_PUBLIC_CASH_DISCOUNT_GATEWAY_URL:'ws://localhost:3002'}},
  sessionStorage:{getItem:()=>organization},WebSocket:class{constructor(){sockets++;}}});
 const run=exports.runCashDiscountLiveRequest({connectionId:'connection-a',companyName:'A',operation:'scan'});
 organization='org-b';epoch++;resolve('token');
 await assert.rejects(run,error=>error.name==='AbortError');assert.equal(sockets,0);
});
