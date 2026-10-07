import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFile} from 'node:fs/promises';import ts from 'typescript';
const source=await readFile(new URL('./api-client.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture(){
 const session=deferred(),refresh=deferred(),calls=[];let org='org-a',epoch=0;
 const client={auth:{onAuthStateChange(){},getSession:()=>session.promise,refreshSession:()=>refresh.promise}};
 const exports={};const imports={'@/lib/supabase/client':{createSupabaseBrowserClient:()=>client},'@/lib/access-cache':{accessCacheEpoch:()=>epoch}};
 vm.runInNewContext(code,{exports,require:name=>{if(!(name in imports))throw Error(name);return imports[name];},process:{env:{}},Headers,Date,performance,DOMException,queueMicrotask,Event,
  sessionStorage:{getItem:()=>org},window:{dispatchEvent(){}},fetch:async(url,init)=>{calls.push({url,headers:init.headers});return Response.json({}, {status:calls.length===1?401:200});}});
 return {apiFetch:exports.apiFetch,calls,session,refresh,change(){org='org-b';epoch++;}};
}
test('token refresh cannot retarget an existing request to another organization',async()=>{
 const f=fixture();const request=f.apiFetch('/api/cases',{method:'POST'});
 const outcome=assert.rejects(request,error=>error.name==='AbortError');
 f.change();f.session.resolve({data:{session:{access_token:'old'}}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.calls[0].headers.get('X-Kalika-Organization'),'org-a');
 f.refresh.resolve({data:{session:{access_token:'new'}}});await outcome;
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].headers.get('X-Kalika-Organization'),'org-a');
});
test('explicit organization stays pinned during token renewal',async()=>{
 const f=fixture();const result=f.apiFetch('/api/access/me',{headers:{'X-Kalika-Organization':'explicit-org'}});
 f.session.resolve({data:{session:{access_token:'old'}}});await new Promise(resolve=>setImmediate(resolve));
 f.refresh.resolve({data:{session:{access_token:'new'}}});assert.equal((await result).status,200);
 assert.ok(f.calls.every(call=>call.headers.get('X-Kalika-Organization')==='explicit-org'));
});
